#!/usr/bin/env node
// Real swarm sampling for the torrent bench (metadata + handshakes only, never any piece).
//
//   node scripts/torrent-real-sample.mjs select   # AniList tiers → ARM ids → addon streams → candidates.json
//   node scripts/torrent-real-sample.mjs report   # probes.json (from `tbench probe-real`) → real-report.md + calibration.json
//
// Output in ${TBENCH_ROOT:-/private/tmp/claude-501/tbench}/real/. Every HTTP response is cached
// there (cache/), and network requests are spaced ≥ 1.1 s apart (polite to AniList, ARM and the addons).
//
// Addons (the user's pack, raw torrents, no debrid): Torrentio (language=french) and Comet (ElfHosted).
// Ids as the app builds them (src/addons/id-candidates.ts): `kitsu:<id>:<ep>` and IMDb
// `tt…:<season>:<ep>` (TheTVDB season from ARM; no IMDb guess past ep. 26 without a season).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.TBENCH_ROOT ?? '/private/tmp/claude-501/tbench';
const OUT = join(ROOT, 'real');
const CACHE = join(OUT, 'cache');
mkdirSync(CACHE, { recursive: true });

const ADDONS = [
  { name: 'Torrentio', base: 'https://torrentio.strem.fun/language=french' },
  { name: 'Comet', base: 'https://comet.elfhosted.com' },
];
const PER_TIER = Number(process.env.PER_TIER ?? 10);
const TOP = 4;

let last = 0;
async function throttle() {
  const wait = last + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
}

async function cachedFetch(url, init = {}, key = url) {
  const file = join(CACHE, createHash('sha1').update(key).digest('hex') + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  await throttle();
  let res;
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(40_000), headers: { Accept: 'application/json', ...(init.headers ?? {}) } });
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    res = { status: r.status, body, at: new Date().toISOString() };
  } catch (e) {
    res = { status: 0, error: String(e), body: null, at: new Date().toISOString() };
  }
  // Errors are cached too (re-running never hammers a failing service); delete cache/ to retry.
  writeFileSync(file, JSON.stringify(res));
  return res;
}

const ANILIST_FIELDS = `id title { romaji english } format status seasonYear startDate { year } popularity episodes nextAiringEpisode { episode }`;
async function anilist(variables, filter) {
  const query = `query ($page: Int, $perPage: Int) { Page(page: $page, perPage: $perPage) { media(type: ANIME, ${filter}) { ${ANILIST_FIELDS} } } }`;
  const r = await cachedFetch(
    'https://graphql.anilist.co',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) },
    `anilist:${filter}:${JSON.stringify(variables)}`,
  );
  if (!r.body?.data) throw new Error(`AniList: ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}`);
  return r.body.data.Page.media;
}

// Tiers (deterministic queries, so the sample is reproducible):
// - popular: the most popular shows airing now (latest aired episode, what people watch this week)
// - mid: finished TV shows with 20k–80k AniList members (page 3 of the popularity ranking)
// - obscure: half old (< 2005) and half recent-but-niche (2010+) shows with 300–1500 members
async function selectTitles() {
  const popular = await anilist({ page: 1, perPage: PER_TIER }, 'status: RELEASING, format: TV, sort: POPULARITY_DESC');
  const mid = await anilist({ page: 3, perPage: PER_TIER }, 'status: FINISHED, format: TV, popularity_greater: 20000, popularity_lesser: 80000, sort: POPULARITY_DESC');
  const half = Math.ceil(PER_TIER / 2);
  const oldNiche = await anilist({ page: 1, perPage: half }, 'status: FINISHED, format_in: [TV, OVA], popularity_greater: 300, popularity_lesser: 1500, startDate_lesser: 20050000, sort: POPULARITY_DESC');
  const newNiche = await anilist({ page: 1, perPage: PER_TIER - half }, 'status: FINISHED, format: TV, popularity_greater: 300, popularity_lesser: 1500, startDate_greater: 20100000, sort: POPULARITY_DESC');
  const tag = (tier) => (m) => ({ tier, ...m });
  return [...popular.map(tag('popular')), ...mid.map(tag('mid')), ...[...oldNiche, ...newNiche].map(tag('obscure'))];
}

function parseStream(s, addon) {
  const text = `${s.name ?? ''}\n${s.title ?? s.description ?? ''}`;
  const seeders = /👤\s*(\d+)/u.exec(text)?.[1];
  const size = /💾\s*([\d.]+)\s*([KMGT]i?B)/u.exec(text);
  const mult = { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
  const quality = /\b(2160p|4k|1080p|720p|576p|480p)\b/i.exec(text)?.[1]?.toLowerCase() ?? 'unknown';
  return {
    addon,
    infoHash: s.infoHash?.toLowerCase(),
    fileIdx: s.fileIdx ?? null,
    filename: s.behaviorHints?.filename ?? null,
    sources: s.sources ?? [],
    seeders: seeders != null ? Number(seeders) : null,
    sizeBytes: size ? Math.round(Number(size[1]) * (mult[size[2]] ?? 1)) : null,
    quality,
    title: (s.title ?? s.description ?? '').split('\n')[0].slice(0, 160),
  };
}

async function select() {
  const titles = await selectTitles();
  const out = [];
  const cometFailures = { n: 0 };
  for (const t of titles) {
    const arm = (await cachedFetch(`https://arm.haglund.dev/api/v2/ids?source=anilist&id=${t.id}`)).body ?? {};
    const episode = t.status === 'RELEASING' ? Math.max(1, (t.nextAiringEpisode?.episode ?? 2) - 1) : 1;
    const season = arm['thetvdb-season'] ?? arm['themoviedb-season'] ?? null;
    const ids = [];
    if (arm.kitsu) ids.push(`kitsu:${arm.kitsu}:${episode}`);
    if (arm.imdb && /^tt\d+$/.test(arm.imdb) && !(season == null && episode > 26)) ids.push(`${arm.imdb}:${season ?? 1}:${episode}`);
    const requests = [];
    const torrents = new Map();
    for (const addon of ADDONS) {
      for (const id of ids) {
        // Stop asking an addon that refuses every request (3 failures in a row, no result yet).
        if (addon.name === 'Comet' && cometFailures.n >= 3 && !cometFailures.ok) {
          requests.push({ addon: addon.name, id, status: 'skipped (403s)', count: 0 });
          continue;
        }
        const r = await cachedFetch(`${addon.base}/stream/series/${id}.json`);
        const streams = Array.isArray(r.body?.streams) ? r.body.streams : [];
        if (addon.name === 'Comet') {
          if (r.status === 200) cometFailures.ok = true;
          else cometFailures.n++;
        }
        const withHash = streams.filter((s) => s.infoHash);
        requests.push({ addon: addon.name, id, status: r.status, count: streams.length, torrents: withHash.length });
        for (const s of withHash) {
          const p = parseStream(s, addon.name);
          const prev = torrents.get(p.infoHash);
          if (!prev) torrents.set(p.infoHash, { ...p, addons: [addon.name], via: [id] });
          else {
            if (!prev.addons.includes(addon.name)) prev.addons.push(addon.name);
            if (!prev.via.includes(id)) prev.via.push(id);
            prev.seeders = Math.max(prev.seeders ?? 0, p.seeders ?? 0);
            prev.fileIdx ??= p.fileIdx;
            prev.filename ??= p.filename;
          }
        }
      }
    }
    const list = [...torrents.values()];
    out.push({
      tier: t.tier,
      anilist: t.id,
      title: t.title.english ?? t.title.romaji,
      format: t.format,
      year: t.seasonYear ?? t.startDate?.year,
      popularity: t.popularity,
      episode,
      ids: { kitsu: arm.kitsu ?? null, imdb: arm.imdb ?? null, season },
      requests,
      torrentCount: list.length,
      torrents: list,
      // What the app races: the first distinct torrents in addon order (Torrentio's ranking first).
      top: list.slice(0, TOP).map((x) => ({ infoHash: x.infoHash, fileIdx: x.fileIdx, filename: x.filename, sources: x.sources, seeders: x.seeders, sizeBytes: x.sizeBytes, quality: x.quality, title: x.title, episode })),
    });
    console.error(`${t.tier.padEnd(8)} ${String(t.popularity).padStart(7)}  ${(t.title.english ?? t.title.romaji).slice(0, 40).padEnd(40)} ep${episode}  ${list.length} torrents  ${requests.map((r) => `${r.addon}:${r.status}`).join(' ')}`);
  }
  writeFileSync(join(OUT, 'candidates.json'), JSON.stringify(out, null, 1));
  console.error(`→ ${join(OUT, 'candidates.json')}`);
}

// ---------------------------------------------------------------- report
const pct = (arr, p) => {
  const v = arr.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const r = p * (v.length - 1);
  const lo = Math.floor(r);
  const hi = Math.ceil(r);
  return v[lo] + (v[hi] - v[lo]) * (r - lo);
};
const f = (x, d = 1) => (x == null ? '—' : Number(x).toFixed(d));
const mp = (arr, d = 1) => `${f(pct(arr, 0.5), d)} / ${f(pct(arr, 0.9), d)}`;
const share = (n, d) => (d ? `${Math.round((100 * n) / d)} %` : '—');

function report() {
  const cands = JSON.parse(readFileSync(join(OUT, 'candidates.json'), 'utf8'));
  const probes = JSON.parse(readFileSync(join(OUT, 'probes.json'), 'utf8'));
  const byHash = new Map(probes.map((p) => [`${p.anilist}:${p.infoHash}`, p]));
  const tiers = ['popular', 'mid', 'obscure'];
  let md = `# Real swarm sampling — metadata + handshakes only\n\n`;
  md += `Generated ${new Date().toISOString()}. Engine probe (huwa-v1 \`probe.rs\`): magnet metadata via ut_metadata (list_only), read-only DHT lookup, 68-byte BitTorrent handshakes; **no piece was requested, nothing written to disk, nothing seeded**. Probe run with a 30 s deadline and minPeers=40 (so it keeps counting answering peers); "healthy" below = metadata + file + ≥ 3 answering peers (the app's rule), with its time read from the probe timeline. "≤ 8 s" = what the app's default 8 s race would have seen.\n\n`;
  const calib = {};
  md += `## Per tier\n\n| tier | episodes | with torrents | torrents / ep (median) | announced 👤 top-4 (med / p90) | metadata s (med / p90) | metadata failed | answering peers (med / p90) | DHT+tracker peers seen (med / p90) | healthy s (med / p90) | ep. with ≥1 healthy torrent | ≥1 healthy within 8 s | only weak/dead |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  const rows = [];
  for (const tier of tiers) {
    const eps = cands.filter((c) => c.tier === tier);
    const ps = eps.flatMap((c) => c.top.map((t) => ({ ...t, ep: c, probe: byHash.get(`${c.anilist}:${t.infoHash}`) }))).filter((x) => x.probe);
    const metas = ps.map((x) => (x.probe.metaMs != null ? x.probe.metaMs / 1000 : null));
    const failed = ps.filter((x) => x.probe.metaMs == null).length;
    const answering = ps.map((x) => x.probe.maxConnected ?? 0);
    const seen = ps.map((x) => x.probe.maxPeers ?? 0);
    const healthyT = ps.map((x) => (x.probe.healthyMs != null ? x.probe.healthyMs / 1000 : null));
    const epHealthy = eps.filter((c) => c.top.some((t) => byHash.get(`${c.anilist}:${t.infoHash}`)?.healthyMs != null)).length;
    const epHealthy8 = eps.filter((c) => c.top.some((t) => (byHash.get(`${c.anilist}:${t.infoHash}`)?.healthyMs ?? Infinity) <= 8000)).length;
    const withT = eps.filter((c) => c.torrentCount > 0).length;
    const onlyWeak = eps.filter((c) => c.torrentCount > 0 && !c.top.some((t) => byHash.get(`${c.anilist}:${t.infoHash}`)?.healthyMs != null)).length;
    md += `| ${tier} | ${eps.length} | ${withT} | ${f(pct(eps.map((c) => c.torrentCount), 0.5), 0)} | ${mp(ps.map((x) => x.seeders), 0)} | ${mp(metas)} | ${failed}/${ps.length} | ${mp(answering, 0)} | ${mp(seen, 0)} | ${mp(healthyT)} | ${share(epHealthy, eps.length)} | ${share(epHealthy8, eps.length)} | ${share(onlyWeak + (eps.length - withT), eps.length)} |\n`;
    // Calibration: the best probed torrent per episode (what the race would start).
    const best = eps
      .map((c) => c.top.map((t) => byHash.get(`${c.anilist}:${t.infoHash}`)).filter(Boolean).sort((a, b) => (b.maxConnected ?? 0) - (a.maxConnected ?? 0))[0])
      .filter((p) => p && p.metaMs != null);
    const firstAnswer = best.map((p) => p.timeline?.find((s) => s.connected > 0)?.t ?? null);
    const arrivals = best.map((p) => p.timeline ?? []);
    calib[tier] = {
      episodes: eps.length,
      bestAnswering: { median: pct(best.map((p) => p.maxConnected ?? 0), 0.5), p10: pct(best.map((p) => p.maxConnected ?? 0), 0.1), p90: pct(best.map((p) => p.maxConnected ?? 0), 0.9) },
      metadataS: { median: pct(best.map((p) => p.metaMs / 1000), 0.5), p90: pct(best.map((p) => p.metaMs / 1000), 0.9) },
      firstAnswerS: { median: pct(firstAnswer, 0.5), p90: pct(firstAnswer, 0.9) },
      // Median time at which the k-th answering peer showed up (k = 1..10), seconds.
      kthPeerS: Array.from({ length: 10 }, (_, k) => pct(arrivals.map((tl) => tl.find((s) => s.connected > k)?.t ?? null), 0.5)),
      noHealthyShare: eps.length ? 1 - epHealthy / eps.length : null,
    };
    rows.push({ tier, ps });
  }
  md += `\n## Announced seeders ("👤 N") vs peers that really answered (probed torrents)\n\n| tier | torrents probed | announced 👤 (median) | answering (median) | ratio answering/announced (median / p10) | announced ≥ 5 but 0 answering |\n|---|---|---|---|---|---|\n`;
  for (const { tier, ps } of rows) {
    const withSeed = ps.filter((x) => x.seeders != null);
    const ratios = withSeed.filter((x) => x.seeders > 0).map((x) => (x.probe.maxConnected ?? 0) / x.seeders);
    const lies = withSeed.filter((x) => x.seeders >= 5 && (x.probe.maxConnected ?? 0) === 0).length;
    md += `| ${tier} | ${ps.length} | ${f(pct(withSeed.map((x) => x.seeders), 0.5), 0)} | ${f(pct(ps.map((x) => x.probe.maxConnected ?? 0), 0.5), 0)} | ${f(pct(ratios, 0.5), 2)} / ${f(pct(ratios, 0.1), 2)} | ${lies}/${withSeed.filter((x) => x.seeders >= 5).length} |\n`;
  }
  md += `\nThe probe stops counting at 40 handshakes (\`MAX_HANDSHAKES\`), so "answering" saturates at 40 on big swarms; ratios on popular torrents are lower bounds.\n`;
  md += `\n## Addon answers\n\n| tier | addon | requests | HTTP 200 | with ≥1 torrent | torrents (median per request) |\n|---|---|---|---|---|---|\n`;
  for (const tier of tiers) {
    for (const addon of ADDONS.map((a) => a.name)) {
      const rq = cands.filter((c) => c.tier === tier).flatMap((c) => c.requests.filter((r) => r.addon === addon));
      md += `| ${tier} | ${addon} | ${rq.length} | ${rq.filter((r) => r.status === 200).length} | ${rq.filter((r) => (r.torrents ?? 0) > 0).length} | ${f(pct(rq.map((r) => r.torrents ?? 0), 0.5), 0)} |\n`;
    }
  }
  md += `\n## Episodes\n\n| tier | title | year | AniList members | ep | torrents | top-4 announced 👤 | top-4 answering | top-4 metadata s | best state |\n|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const c of cands) {
    const pr = c.top.map((t) => byHash.get(`${c.anilist}:${t.infoHash}`));
    const states = pr.map((p) => (p?.healthyMs != null ? 'healthy' : p?.metaMs != null ? 'weak' : p ? 'failed' : '—'));
    const best = states.includes('healthy') ? 'healthy' : states.includes('weak') ? 'weak' : c.torrentCount ? 'dead' : 'no torrent';
    md += `| ${c.tier} | ${c.title.replace(/\|/g, '/')} | ${c.year ?? ''} | ${c.popularity} | ${c.episode} | ${c.torrentCount} | ${c.top.map((t) => t.seeders ?? '?').join(', ')} | ${pr.map((p) => p?.maxConnected ?? '—').join(', ')} | ${pr.map((p) => (p?.metaMs != null ? f(p.metaMs / 1000) : '✗')).join(', ')} | ${best} |\n`;
  }
  writeFileSync(join(OUT, 'real-report.md'), md);
  writeFileSync(join(OUT, 'calibration.json'), JSON.stringify(calib, null, 1));
  console.log(md);
  console.error(`→ ${join(OUT, 'real-report.md')}, ${join(OUT, 'calibration.json')}`);
}

const cmd = process.argv[2];
if (cmd === 'select') await select();
else if (cmd === 'report') report();
else {
  console.error('usage: torrent-real-sample.mjs select|report');
  process.exit(1);
}
