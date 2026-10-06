// Source selection for the player.
// Auto mode runs a "course des sources" (./race.ts, ./race-runner.ts): the best candidates (direct
// links, debrid-cached torrents once resolved) are measured with one small ranged GET each; dead
// links are dropped before the player sees them, and playback starts with the best quality that
// is fast enough, language fit first. Once a source plays it stays put ("locked"); a strictly
// better quality that proved fast is offered as `upgrade`, which the player swaps in without
// stopping (components/player/seamless-upgrade.ts) or keeps for the next episode.
// A source that fails is skipped; the last good one is the fallback.
// Manual mode: the user picked a source in the menu; a failure drops back to auto.
// Hosted player pages ("lecteurs web", see web-player.ts) are used by auto mode only when no
// native source exists; the page is then shown in the web player instead of the native one.
// Answers served from the disk cache (registry.ts) may carry expired links: a failure on one of
// them refetches the addons once and gives that source another chance before dropping it.
// `preview` (pre-search from a detail page / the home screen): same search and race, but a
// torrent is only resolved through a debrid service. On an unmetered network the torrent race
// runs too (probes: metadata + peers, no piece) and the winner is pre-warmed: the engine fetches
// its first pieces and container index, then parks it (src/torrent/index.ts `prewarmTorrent`).
// The tap then reuses the race winner (`peerWins`) and finds those pieces on disk.
// Torrent race: when only torrents the on-device engine would download remain (nothing cached by
// a debrid service, no direct link), the best few (language first) are probed in parallel by the
// engine — metadata + answering peers, no piece — and the first healthy swarm is started; the
// others are cancelled at once (src/torrent/peer-race.ts, use-peer-race.ts).
import { useEffect, useMemo, useRef, useState } from 'react';

import { useSettings } from '@/settings/settings';
import { useRaceBudget, useTorrentProbeBudget, useUnmetered } from '@/settings/network';
import { resolveTorrent, resolveTorrentViaDebrid, useCachedHashes, useTorrentResolver } from '@/debrid/resolve';
import { canProbeTorrents, dropTorrent, holdTorrent, prewarmTorrent, useTorrentSettings } from '@/torrent';
import { engineHashOf } from '@/torrent/stream-input';
import {
  decidePeerRace,
  packKeys,
  peerLabel,
  probeTargets,
  reusableWin,
  shouldWiden,
  unpackKeys,
  wrongTorrents,
  type PeerCandidate,
  type PeerProbe,
  type PeerWin,
} from '@/torrent/peer-race';
import { peerClock, usePeerRace, type PeerTarget } from '@/torrent/use-peer-race';

import { langScore } from './audio';
import { isExternal, isPlayable, isTorrent, isYouTube, type AddonStream } from './protocol';
import { decideStart, estimateBitrateMbps, pickUpgrade, speedLabel, speedVerdict, type RaceCandidate, type Speed, type UpgradeSide } from './race';
import { raceClock, useRace, type RaceEntry } from './race-runner';
import { detectQuality, rankStreams, streamKey, type Quality } from './quality';
import { classifyNoSource } from './no-source';
import { useAddonPrefs, useAddons, useStreams } from './registry';
import { autoWebPlayerUrl, hostOf, needsProbe, useProbedUrls, webPlayerUrl } from './web-player';

type Resolution = { url?: string; via?: string; error?: string };

export type SourceState = 'playing' | 'resolving' | 'failed' | 'ready' | 'needs-debrid' | 'youtube' | 'external' | 'web' | 'unusable';

/** Better source the player may swap to without stopping (see `useSource().upgrade`). */
export type SourceUpgrade = { key: string; uri: string; headers?: Record<string, string>; quality: Quality | null };

// Stremio `bingeGroup`: the release last played for a series, preferred for its next episode
// (same group, same quality/subs/audio), as Stremio's binge-watching does.
const lastBinge = new Map<string, string>();
const NO_SUBS: NonNullable<AddonStream['subtitles']> = [];
/** Cached torrents resolved ahead to join the race (debrid only). */
const RACE_TORRENTS = 2;

const isLoopback = (u: string) => /^https?:\/\/(127\.|localhost[:/]|\[::1\])/i.test(u);

/**
 * Torrent race winners by episode (`seriesId:episode`), from the pre-search or an earlier watch:
 * the tap starts that torrent at once instead of racing again (its metadata and peers are still
 * in the engine's probe cache). See `reusableWin`.
 */
const peerWins = new Map<string, PeerWin>();

export type SourceOptions = {
  /** false = idle (used to prefetch the next episode only once armed). */
  enabled?: boolean;
  /** Pre-search: no on-device torrent engine, nothing remembered as "played". */
  preview?: boolean;
  /** The on-device torrent engine exists but is switched off (for the "no source" reason). */
  engineAvailable?: boolean;
};

/** Copy of `rec` without `k` (a cleared resolution must re-trigger resolving, not block it). */
function dropKey<T>(rec: Record<string, T>, k: string): Record<string, T> {
  if (!(k in rec)) return rec;
  const next = { ...rec };
  delete next[k];
  return next;
}

export function useSource(seriesId: string, episode: number, { enabled = true, preview = false, engineAvailable = false }: SourceOptions = {}) {
  const { streams, infos, pending, failed, asked, refreshed, refresh } = useStreams(seriesId, episode, enabled);
  const prefs = useAddonPrefs();
  const { watchMode, subLangs, dubLangs } = useSettings();
  const langPrefs = useMemo(() => ({ watchMode, subLangs, dubLangs }), [watchMode, subLangs, dubLangs]);
  const addonList = useAddons();
  const resolverLabel = useTorrentResolver();
  const cached = useCachedHashes(streams.filter(isTorrent).map((s) => s.infoHash!));
  const probed = useProbedUrls(streams, enabled);
  const budget = useRaceBudget();
  const torrentBudget = useTorrentProbeBudget();
  const unmetered = useUnmetered();
  // Re-render when the engine is switched on/off or "Wi-Fi only" changes (`canProbeTorrents`).
  useTorrentSettings();
  const peerScope = `${seriesId}:${episode}`;

  const ranked = useMemo(
    () => rankStreams(streams, {
      preferred: prefs.preferredQuality,
      addonOrder: addonList.map((a) => a.manifest.id),
      canResolveTorrents: !!resolverLabel,
      cached,
      lang: (s) => langScore(s, langPrefs),
      probed,
    }),
    [streams, prefs.preferredQuality, addonList, resolverLabel, cached, probed, langPrefs],
  );

  const [manual, setManual] = useState<string | undefined>();
  const [bad, setBad] = useState<string[]>([]);
  const [resolved, setResolved] = useState<Record<string, Resolution>>({});
  /** Auto source handed to the player: kept until it fails or is upgraded. */
  const [locked, setLocked] = useState<string | undefined>();
  /** Upgrades tried and abandoned (stalled, other engine…): not offered again. */
  const [skipUpgrade, setSkipUpgrade] = useState<string[]>([]);
  /** Cached links that failed, waiting for the addons' fresh answer (refresh generation). */
  const [suspended, setSuspended] = useState<{ keys: string[]; gen: number }>({ keys: [], gen: -1 });
  /** Torrents the probes showed not to contain this episode (never started), per episode. */
  const [wrong, setWrong] = useState<{ scope: string; keys: string[] }>({ scope: peerScope, keys: [] });
  const wrongKeys = wrong.scope === peerScope ? wrong.keys : [];
  /** Cached links already given their second chance. */
  const retried = useRef(new Set<string>());
  // The fresh answer arrived: suspended links compete again (same link = retried once).
  const suspendedKeys = suspended.gen >= 0 && refreshed > suspended.gen ? [] : suspended.keys;

  /** Hosted player page of this stream, or null. */
  const webOf = (s: AddonStream) => webPlayerUrl(s, probed);
  const direct = (s: AddonStream) => isPlayable(s) && !webOf(s);
  /** Extension-less link whose headers are still being checked (could be a player page). */
  const probing = (s: AddonStream) => needsProbe(s) && !probed[s.url!];
  const usable = (s: AddonStream) => direct(s) || (isTorrent(s) && !!resolverLabel);
  const cachedOf = (s: AddonStream) => (isTorrent(s) ? cached[s.infoHash!.toLowerCase()] : undefined);
  /** Safe = expected to start quickly: direct link, or torrent already cached by the debrid service. */
  const safe = (s: AddonStream) => direct(s) || cachedOf(s) === true;
  /** URL the native player would open for this stream (direct link or resolved torrent). */
  const playUrlOf = (s: AddonStream): string | undefined => (direct(s) ? s.url : isTorrent(s) ? resolved[streamKey(s)]?.url : undefined);
  /** URL the race may measure: never a page, never the on-device torrent engine (loopback). */
  const raceUrlOf = (s: AddonStream) => {
    const u = playUrlOf(s);
    return u && !isLoopback(u) ? u : undefined;
  };
  const headersOf = (s: AddonStream) => s.behaviorHints?.proxyHeaders?.request;

  // Language fit (VF / VOSTFR… per the user's preferences), lower is better.
  const langOf = (s: AddonStream) => langScore(s, langPrefs);
  // Quality score, higher is better.
  const qualityOf = (s: AddonStream) => {
    const pref = prefs.preferredQuality;
    let q = detectQuality(s) ?? 0;
    // Uncached torrent played by the on-device engine: speed depends on peers, not resolution.
    // 1080p is enough on a phone; the seeder count (Torrentio "👤 N") breaks ties.
    if (isTorrent(s) && cachedOf(s) !== true) {
      const seeds = Number(/👤\s*(\d+)/.exec(`${s.title ?? ''} ${s.description ?? ''}`)?.[1] ?? 0);
      q = Math.min(q, 1080) + Math.min(seeds, 500) / 1000;
      if (seeds && seeds < 3) q -= 400;
    }
    return pref !== 'auto' && q > pref ? pref - (q - pref) / 10 : q;
  };

  // ---- candidates: usable, not failed, not still being classified (preference order) ----
  const candidates = useMemo(() => {
    const list = ranked.filter((s) => usable(s) && !bad.includes(streamKey(s)) && !suspendedKeys.includes(streamKey(s)) && !probing(s));
    // Language, then quality, then the ranking (stable sort).
    return list.sort((a, b) => langOf(a) - langOf(b) || qualityOf(b) - qualityOf(a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranked, bad, suspendedKeys, resolverLabel, cached, probed, prefs.preferredQuality, langPrefs]);

  // ---- cached torrents at the top: resolved ahead (debrid only) to be measured too ----
  const torrentKeys = enabled
    ? packKeys(candidates.filter((s) => isTorrent(s) && cachedOf(s) === true).slice(0, RACE_TORRENTS).map(streamKey))
    : '';
  useEffect(() => {
    if (!torrentKeys || budget.max === 0) return;
    const ctrl = new AbortController();
    for (const k of unpackKeys(torrentKeys)) {
      const s = candidates.find((x) => streamKey(x) === k);
      if (!s || resolved[k]) continue;
      resolveTorrentViaDebrid(
        { infoHash: s.infoHash!, fileIdx: s.fileIdx, filename: s.behaviorHints?.filename, sources: s.sources, episode },
        ctrl.signal,
      )
        .then((r) => r && !ctrl.signal.aborted && setResolved((m) => (m[k] ? m : { ...m, [k]: { url: r.url, via: r.via } })))
        .catch(() => {});
    }
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [torrentKeys, budget.max]);

  // ---- the race ----
  const entries: RaceEntry[] = candidates.flatMap((s) => {
    const u = raceUrlOf(s);
    return u ? [{ url: u, headers: headersOf(s) }] : [];
  });
  const race = useRace(entries, budget, enabled);
  const resultOf = (s: AddonStream) => {
    const u = raceUrlOf(s);
    return u ? race.results[u] : undefined;
  };
  const bitrateOf = (s: AddonStream) => estimateBitrateMbps(s, detectQuality(s));
  const speedOf = (s: AddonStream): Speed | undefined => {
    const r = resultOf(s);
    return r ? speedVerdict(r, bitrateOf(s)) : undefined;
  };
  const deadKeys = useMemo(
    () => new Set(candidates.filter((s) => resultOf(s)?.alive === false).map(streamKey)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates, race.results, resolved],
  );

  // A link from the disk cache proved dead in the race: the addons are asked again (once).
  const cachedDead = enabled && candidates.some((s) => s.cachedAt != null && deadKeys.has(streamKey(s)));
  const refreshedForDead = useRef(false);
  useEffect(() => {
    if (!cachedDead || refreshedForDead.current) return;
    refreshedForDead.current = true;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cachedDead]);

  // ---- pool: safe sources first (direct link, cached torrent), dead links out ----
  const pool = useMemo(() => {
    const alive = candidates.filter((s) => !deadKeys.has(streamKey(s)) && !wrongKeys.includes(streamKey(s)));
    // Only hosted players: the best of them (quality, then addon priority).
    const web = alive.length ? [] : ranked.filter((s) => !!autoWebPlayerUrl(s, probed) && !bad.includes(streamKey(s)) && !probing(s));
    return alive.some(safe) ? alive.filter(safe) : alive.length ? alive : web;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, deadKeys, ranked, probed, bad, wrongKeys]);

  const binge = lastBinge.get(seriesId);
  const [tick, setTick] = useState(0);
  const decision = useMemo(() => {
    const cands: RaceCandidate[] = pool.map((s) => {
      const u = raceUrlOf(s);
      return {
        key: streamKey(s),
        lang: langOf(s),
        quality: qualityOf(s),
        bitrateMbps: bitrateOf(s),
        result: u ? race.results[u] : undefined,
        probing: !!u && race.probing.has(u),
        binge: !!binge && s.behaviorHints?.bingeGroup === binge,
        doneAtMs: u ? race.doneAt(u) ?? 0 : undefined,
      };
    });
    if (!cands.length) return null;
    return decideStart(cands, race.startedAt != null ? raceClock() - race.startedAt : 0);
    // `tick` re-evaluates when a grace window / deadline expires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, race.results, race.probing, binge, resolved, tick]);

  // Waiting for the grace window / a deadline: re-evaluate when it ends.
  const waitMs = decision && decision.key === null && 'waitMs' in decision ? decision.waitMs : 0;
  useEffect(() => {
    if (!waitMs) return;
    const t = setTimeout(() => setTick((n) => n + 1), waitMs + 10);
    return () => clearTimeout(t);
  }, [waitMs, decision]);

  // The playing source stays even when a background refresh of the addons no longer lists it
  // (new links for the same files): playback never restarts because of a refresh.
  const [lastLocked, setLastLocked] = useState<AddonStream | undefined>();
  const lockedListed = locked && !bad.includes(locked) ? ranked.find((s) => streamKey(s) === locked) : undefined;
  if (lockedListed && lockedListed !== lastLocked) setLastLocked(lockedListed);
  const lockedStream = lockedListed ?? (locked && !bad.includes(locked) && lastLocked && streamKey(lastLocked) === locked ? lastLocked : undefined);

  // ---- torrent race (on-device engine): uncached torrents probed in parallel ----
  const engineTorrent = (s: AddonStream) => isTorrent(s) && cachedOf(s) !== true;
  // Pre-search: probes (no piece) only on an unmetered network, where the winner is pre-warmed.
  const presearchProbes = preview && unmetered;
  const peerWanted =
    enabled && (!preview || presearchProbes) && !manual && !lockedStream && torrentBudget.base > 0 && canProbeTorrents() && pool.some(engineTorrent) && !pool.some(safe);
  const peerPool = peerWanted ? pool.filter(engineTorrent) : [];
  // Decided a moment ago for this episode (pre-search, previous visit): no new race.
  const recentWin = peerWins.get(peerScope);
  // When this screen opened (the tap): a race decided before it is reused, one decided after is ours.
  const [mountedAt] = useState(() => Date.now());
  const reuse = peerWanted && !preview ? reusableWin(recentWin, mountedAt, peerPool.map(streamKey), bad.length) : undefined;
  const presearched = reuse ? peerPool.find((s) => streamKey(s) === reuse.key) : undefined;
  // A new round whenever a source failed (e.g. the winner would not start): the next best
  // torrents are probed again instead of being started blindly one by one.
  const raceScope = `${peerScope}#${bad.length}`;
  /** Round whose candidates all looked weak: it probes up to `torrentBudget.max` of them. */
  const [widened, setWidened] = useState<string | null>(null);
  const raceWidth = widened === raceScope ? torrentBudget.max : torrentBudget.base;
  // Stream keys contain the addon's multi-line name / title: packed as JSON, never joined on '\n'.
  const peerKeys = packKeys(probeTargets(peerPool.map((s) => ({ key: streamKey(s) })), raceWidth));
  const peerTargets = useMemo<PeerTarget[]>(
    () =>
      peerKeys
        ? unpackKeys(peerKeys).flatMap((k) => {
            const s = pool.find((x) => streamKey(x) === k);
            return s
              ? [{ key: k, infoHash: s.infoHash!, sources: s.sources, name: s.behaviorHints?.filename ?? s.title?.split('\n')[0], fileIdx: s.fileIdx, filename: s.behaviorHints?.filename, episode }]
              : [];
          })
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [peerKeys, episode],
  );
  // Armed only with something to probe: a race without probes would wait for its deadline forever.
  const peerOn = peerWanted && peerTargets.length > 0 && !presearched;
  const peerCands = (probes: Record<string, PeerProbe>): PeerCandidate[] =>
    peerPool.map((s) => ({ key: streamKey(s), lang: langOf(s), probe: probes[streamKey(s)] }));
  const decidePeers = (probes: Record<string, PeerProbe>, startedAt: number | null) =>
    decidePeerRace(peerCands(probes), startedAt != null ? peerClock() - startedAt : 0);
  const peer = usePeerRace(raceScope, peerTargets, peerOn, (probes, at) => {
    const d = decidePeers(probes, at);
    return d.key !== null || 'exhausted' in d;
  });
  const peerDecision = peerOn ? decidePeers(peer.probes, peer.startedAt) : null;
  // Obscure title (only weak swarms so far): probe more candidates — packs, other qualities —
  // within the budget, still committing by the race deadlines. Adjusted during render.
  if (
    peerOn &&
    peer.active &&
    widened !== raceScope &&
    torrentBudget.max > torrentBudget.base &&
    peer.startedAt != null &&
    shouldWiden(Object.values(peer.probes), peerClock() - peer.startedAt)
  ) {
    setWidened(raceScope);
  }
  const peerWaitMs = peerDecision && peerDecision.key === null && 'waitMs' in peerDecision ? peerDecision.waitMs : 0;
  useEffect(() => {
    if (!peerWaitMs) return;
    const t = setTimeout(() => setTick((n) => n + 1), peerWaitMs + 10);
    return () => clearTimeout(t);
  }, [peerWaitMs, peer.probes]);
  // Wrong torrent (episode not inside): out of the pool, the next candidate gets probed.
  const newlyWrong = wrongTorrents(peer.probes).filter((k) => !wrongKeys.includes(k));
  if (newlyWrong.length) setWrong({ scope: peerScope, keys: [...wrongKeys, ...newlyWrong] });

  // No verdict from the probes (none playable): the plain ranking, as before.
  const peerPick = presearched ?? (peerDecision?.key ? pool.find((s) => streamKey(s) === peerDecision.key) : undefined);
  const peerPickKey = peerPick ? streamKey(peerPick) : undefined;
  useEffect(() => {
    if (peerPickKey && peerOn) peerWins.set(peerScope, { key: peerPickKey, at: Date.now(), fileIdx: peer.probes[peerPickKey]?.fileIdx });
    // Recorded when the race decides (the probes of that moment).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerPickKey, peerOn, peerScope]);
  const auto = peerPick ?? (peerWaitMs ? undefined : decision?.key ? pool.find((s) => streamKey(s) === decision.key) : undefined);

  const current = (manual ? ranked.find((s) => streamKey(s) === manual) : undefined) ?? lockedStream ?? auto;
  const currentKey = current ? streamKey(current) : undefined;
  const webUrl = current ? webOf(current) : null;
  const url = current && !webUrl ? playUrlOf(current) : undefined;
  useEffect(() => {
    const group = current?.behaviorHints?.bingeGroup;
    if (enabled && !preview && (url || webUrl) && group) lastBinge.set(seriesId, group);
  }, [enabled, preview, url, webUrl, current, seriesId]);
  // The auto source reached the native player: keep it (no reload when better answers arrive
  // later; upgrades go through `upgrade`). Hosted pages are not kept: a direct link showing up
  // later still replaces them. Adjusted during render ("state from previous render" pattern).
  if (enabled && !manual && !lockedStream && currentKey && url && locked !== currentKey) setLocked(currentKey);

  const markBad = (k: string, error?: string) => {
    const s = ranked.find((x) => streamKey(x) === k) ?? (lastLocked && streamKey(lastLocked) === k ? lastLocked : undefined);
    // Link from the disk cache: maybe just expired. Ask the addons again, then retry once.
    if (s?.cachedAt != null && !retried.current.has(k)) {
      retried.current.add(k);
      setSuspended((p) => ({ keys: p.keys.includes(k) ? p.keys : [...(p.gen >= 0 && refreshed > p.gen ? [] : p.keys), k], gen: refreshed }));
      setResolved((r) => dropKey(r, k));
      setManual((m) => (m === k ? undefined : m));
      setLocked((l) => (l === k ? undefined : l));
      void refresh();
      return;
    }
    setBad((b) => (b.includes(k) ? b : [...b, k]));
    if (error) setResolved((r) => ({ ...r, [k]: { ...r[k], error } }));
    setManual((m) => (m === k ? undefined : m));
    setLocked((l) => (l === k ? undefined : l));
  };

  // Re-run when this source's resolution is cleared (retry / re-pick), not on every resolved change.
  const resolvedState = currentKey ? (resolved[currentKey]?.url ? 'url' : resolved[currentKey]?.error ? 'error' : 'none') : 'none';
  // Torrent → HTTPS through the debrid service (or the native engine once registered).
  useEffect(() => {
    const done = resolved[currentKey ?? ''];
    if (!enabled || !current || !currentKey || !isTorrent(current) || !resolverLabel || done?.url || done?.error) return;
    const ctrl = new AbortController();
    // A season pack without `fileIdx`: the file the probe found for this episode.
    const fileIdx = current.fileIdx ?? peer.probes[currentKey]?.fileIdx ?? (recentWin?.key === currentKey ? recentWin.fileIdx : undefined) ?? undefined;
    const ref = { infoHash: current.infoHash!, fileIdx, filename: current.behaviorHints?.filename, sources: current.sources, episode };
    // Pre-search: debrid only (an on-device torrent would start downloading).
    (preview ? resolveTorrentViaDebrid(ref, ctrl.signal) : resolveTorrent(ref, ctrl.signal, { notCached: cachedOf(current) === false }))
      .then((r) => r && setResolved((m) => ({ ...m, [currentKey]: { url: r.url, via: r.via } })))
      .catch((e) => {
        if (preview) return;
        if (!ctrl.signal.aborted) markBad(currentKey, e instanceof Error ? e.message : 'Échec');
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, resolverLabel, enabled, preview, resolvedState]);

  // Pre-search on an unmetered network: the race winner is pre-warmed (first pieces + container
  // index on disk), held while this pre-search lives, released when it goes (another target, the
  // tap: the watch screen then holds it).
  const prewarm = presearchProbes && peerPick && engineTorrent(peerPick) ? peerPick : undefined;
  const prewarmKey = prewarm ? streamKey(prewarm) : undefined;
  useEffect(() => {
    if (!prewarm || !prewarmKey) return;
    const hash = prewarm.infoHash!.toLowerCase();
    const fileIdx = prewarm.fileIdx ?? peer.probes[prewarmKey]?.fileIdx ?? undefined;
    holdTorrent(hash);
    void prewarmTorrent({ infoHash: hash, fileIdx, sources: prewarm.sources, name: prewarm.behaviorHints?.filename }).catch(() => {});
    return () => dropTorrent(hash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prewarmKey]);

  // The engine torrent this screen plays (or prefetches) is held while it does; left behind
  // (other episode, other source, screen closed), it is released in the engine.
  const heldHash = !preview ? engineHashOf(url) : null;
  useEffect(() => {
    if (!heldHash) return;
    holdTorrent(heldHash);
    return () => dropTorrent(heldHash);
  }, [heldHash]);

  // ---- upgrade: strictly better quality, same language fit, proved fast ----
  const sideOf = (s: AddonStream): UpgradeSide => ({
    key: streamKey(s),
    lang: langOf(s),
    resolution: detectQuality(s) ?? 0,
    quality: qualityOf(s),
    bingeGroup: s.behaviorHints?.bingeGroup,
    web: !!webOf(s),
  });
  const upgradeStream = (() => {
    if (!enabled || manual || !current || !url || webUrl || currentKey !== locked) return undefined;
    const cands = pool
      .filter((s) => !skipUpgrade.includes(streamKey(s)) && !!raceUrlOf(s))
      .map((s) => ({ ...sideOf(s), speed: speedOf(s), mbps: resultOf(s)?.mbps }));
    const best = pickUpgrade(sideOf(current), cands, !!manual);
    return best ? pool.find((s) => streamKey(s) === best.key) : undefined;
  })();
  const upgradeUri = upgradeStream ? raceUrlOf(upgradeStream) : undefined;
  const upgrade = useMemo<SourceUpgrade | null>(
    () => (upgradeStream && upgradeUri
      ? { key: streamKey(upgradeStream), uri: upgradeUri, headers: headersOf(upgradeStream), quality: detectQuality(upgradeStream) }
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [upgradeUri],
  );

  /** The player now plays `key` (seamless swap done). */
  const adoptUpgrade = (key: string) => setLocked(key);
  /**
   * The swap could not happen without interrupting (other engine, stalled…): keep playing, and
   * prefer that release for the next episode.
   */
  const deferUpgrade = (key: string) => {
    setSkipUpgrade((l) => (l.includes(key) ? l : [...l, key]));
    const group = ranked.find((s) => streamKey(s) === key)?.behaviorHints?.bingeGroup;
    if (group) lastBinge.set(seriesId, group);
  };

  const pick = (s: AddonStream | 'auto') => {
    if (s === 'auto') {
      setLocked(undefined);
      return setManual(undefined);
    }
    const k = streamKey(s);
    setBad((b) => b.filter((x) => x !== k));
    setResolved((m) => (m[k]?.error ? dropKey(m, k) : m));
    setManual(k);
  };

  /** "Chercher à nouveau": every addon asked again, failed links given another chance. */
  const retryAll = () => {
    setBad([]);
    setResolved({});
    setSuspended({ keys: [], gen: -1 });
    retried.current.clear();
    setManual(undefined);
    setLocked(undefined);
    void refresh(true);
  };

  // Plain-French reason when nothing can play (watch screen).
  const playableAll = ranked.filter(usable);
  const noSource = !current && !race.probing.size
    ? classifyNoSource({
        asked,
        pending,
        deciding: pool.length > 0 || suspendedKeys.length > 0 || ranked.some(probing),
        streams: streams.length,
        failed,
        torrents: streams.filter(isTorrent).length,
        canResolveTorrents: !!resolverLabel,
        engineAvailable,
        playable: playableAll.length,
        dead: playableAll.filter((s) => bad.includes(streamKey(s)) || deadKeys.has(streamKey(s))).length,
      })
    : null;

  const stateOf = (s: AddonStream): SourceState => {
    const k = streamKey(s);
    if (bad.includes(k)) return 'failed';
    if (k === currentKey) return url || webUrl ? 'playing' : 'resolving';
    if (webOf(s)) return 'web';
    if (usable(s)) return 'ready';
    if (isTorrent(s)) return 'needs-debrid';
    if (isYouTube(s)) return 'youtube';
    if (isExternal(s)) return 'external';
    return 'unusable';
  };

  /** Speed label for the sources menu ("⚡ 1,2 s · 38 Mb/s", "lent", "hors ligne (404)", "test…"). */
  const speedInfo = (s: AddonStream): { label: string; speed?: Speed } | null => {
    const u = raceUrlOf(s);
    // Torrent probed by the engine: "12 pairs", "aucun pair", "recherche de pairs…".
    if (!u) return isTorrent(s) ? peerLabel(peer.probes[streamKey(s)]) : null;
    const speed = speedOf(s);
    const label = speedLabel(race.results[u], speed, race.probing.has(u));
    return label ? { label, speed } : null;
  };

  return {
    ranked,
    current,
    currentKey,
    /** Native player URL (direct link or resolved torrent). */
    url,
    /** Hosted player page to show in the web player instead (never prefetched). */
    web: webUrl ? { url: webUrl, host: hostOf(webUrl) } : null,
    webOf,
    headers: current?.behaviorHints?.proxyHeaders?.request,
    /** Subtitles shipped with the current stream (merged with the subtitles addons by the player). */
    streamSubtitles: current?.subtitles ?? NO_SUBS,
    quality: current ? detectQuality(current) : null,
    auto: !manual,
    pending,
    failed,
    /** Links are being measured before the first one starts. */
    racing: !current && race.probing.size > 0,
    /** Torrent race: the engine is looking for peers before one torrent is started. */
    peerRacing: !current && peerWaitMs > 0,
    /** Playable candidates exist and one is about to be picked (race grace window, deadline). */
    deciding: !current && pool.length > 0,
    /** Links measured / dead so far (sources menu summary). */
    raceStats: { measured: Object.keys(race.results).length, dead: deadKeys.size, enabled: budget.max > 0 },
    /** Addon status rows (not videos), see `infoKind`. */
    infos,
    resolverLabel,
    cachedOf,
    errorOf: (s: AddonStream) => resolved[streamKey(s)]?.error,
    stateOf,
    speedInfo,
    upgrade,
    adoptUpgrade,
    deferUpgrade,
    pick,
    markBad,
    retryAll,
    noSource,
    /** Addons asked (0 = no source addon installed). */
    asked,
  };
}

export const qualityLabel = (q: Quality | null) => (q === 2160 ? '4K' : q ? `${q}p` : 'SD/?');
