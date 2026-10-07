// Source selection for the player.
// Auto mode runs a "course des sources" (./race.ts, ./race-runner.ts): the best candidates (direct
// links, debrid-cached torrents once resolved) are measured with one small ranged GET each; dead
// links are dropped before the player sees them, and playback starts with the best quality that
// is fast enough, language fit first. Once a source plays it is "locked"; from then on the source
// controller (./source-controller.ts, wired by ./use-source-controller.ts) reads `controllerView`
// and moves it: `warmTarget` for a seamless swap (components/player/seamless-upgrade.ts),
// `switchTo` for a switch at the current position, `markBad(…, final)` for another work,
// `reprobe` for background measurements of the alternatives.
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
// Dub mode ("Doublés", see ./dub.ts): while a dubbed candidate (named VF / MULTI / untagged, or
// with a French track once its tracks are known: ./track-info.ts) is alive, the race and the
// torrent probes only spend their budget on those. A candidate only probably dubbed (MULTI,
// untagged) has its tracks checked before it starts (the race's own probe bytes for a link, a
// header sniff through the engine for a torrent). With no dub left, the other versions are
// probed but nothing starts until the user chose (popup on the watch screen) — never a silent
// switch of language.
import { useEffect, useMemo, useRef, useState } from 'react';

import { useSettings } from '@/settings/settings';
import { usePrewarm, useRaceBudget, useTorrentProbeBudget } from '@/settings/network';
import { resolveTorrent, resolveTorrentViaDebrid, useCachedHashes, useTorrentResolver } from '@/debrid/resolve';
import { canProbeTorrents, dropTorrent, holdTorrent, prewarmTorrent, useTorrentSettings } from '@/torrent';
import { engineHashOf } from '@/torrent/stream-input';
import { checkSwarms, swarmCheck, useSwarmChecks } from '@/torrent/swarm-checks';
import {
  afterExhausted,
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

import { classifyDub, detectLangs, DUB_MAYBE, fallbackName, langScore, NOT_DUBBED } from './audio';
import { DUB_WAIT_MS, dubPhase, dubWaitLeft, holdsStart, KNOWN_NO_DUB_WAIT_MS, raceCandidates, splitDub, useDubChoice, useKnownNoDub } from './dub';
import { httpKey, linkFamily, releaseFamily, sniffFailed, torrentKey, trackEntry, useTrackInfo, verifiedAudio } from './track-info';
import { inspectRaceBody, setTorrentOpener, sniffHttp, sniffTorrent } from './track-sniff';
import { isExternal, isPlayable, isTorrent, isYouTube, type AddonStream } from './protocol';
import { decideStart, estimateBitrateMbps, speedLabel, speedVerdict, type RaceCandidate, type Speed } from './race';
import { cachedRace, raceClock, remeasure, setBodyInspector, useRace, type RaceEntry } from './race-runner';
import { EXEMPT_NAME, episodesInName, type CtlCandidate, type CurrentSource } from './source-controller';
import { detectQuality, rankStreams, streamKey, type Quality } from './quality';
import { classifyNoSource } from './no-source';
import { BUILTIN_ID, useAddonPrefs, useAddons, useStreams } from './registry';
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

// The race's probe bytes tell a link's audio tracks; the engine's pre-warm opens a torrent file
// for a header sniff (./track-sniff.ts).
setBodyInspector((url, headers, body) => inspectRaceBody(url, headers, body));
setTorrentOpener(async (t) => (await prewarmTorrent({ infoHash: t.infoHash, fileIdx: t.fileIdx, sources: t.sources, name: t.name }))?.url ?? null);

/** Probably-dubbed candidates (MULTI, untagged) whose tracks said "no dub": after this many, the untagged ones are not tried. */
const MAX_MAYBE_REJECTS = 3;
/** Probably-dubbed torrents sniffed ahead, in parallel (besides the pick itself). */
const SNIFF_AHEAD = 2;
/** Epoch ms (kept out of the render body for the React Compiler). */
const wallClock = () => Date.now();

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
  const { watchMode, subLangs, dubLangs, autoTranslateSubs, dubAutoFallback } = useSettings();
  const langPrefs = useMemo(
    () => ({ watchMode, subLangs, dubLangs, translateSubs: autoTranslateSubs }),
    [watchMode, subLangs, dubLangs, autoTranslateSubs],
  );
  const dubMode = watchMode === 'dub';
  // Track lists learned (header sniffs, the player): re-rank with them.
  const trackVer = useTrackInfo();
  const dubChoice = useDubChoice(seriesId, episode);
  const noDubKnown = useKnownNoDub(seriesId, episode);
  const addonList = useAddons();
  const resolverLabel = useTorrentResolver();
  const cached = useCachedHashes(streams.filter(isTorrent).map((s) => s.infoHash!));
  const probed = useProbedUrls(streams, enabled);
  const budget = useRaceBudget();
  const torrentBudget = useTorrentProbeBudget();
  // Wi-Fi, or cellular without Low Data Mode ("équilibré"): the pre-search may pre-warm.
  const prewarmOk = usePrewarm();
  // Background swarm checks (source controller) re-render the candidates when they end.
  useSwarmChecks();
  // Re-render when the engine is switched on/off or "Wi-Fi only" changes (`canProbeTorrents`).
  useTorrentSettings();
  const peerScope = `${seriesId}:${episode}`;
  const [resolved, setResolved] = useState<Record<string, Resolution>>({});

  /** Keys under which a stream's file tracks are known (./track-info.ts). */
  const trackKeysOf = (s: AddonStream): string[] => {
    if (isTorrent(s)) {
      const keys = [torrentKey(s.infoHash!, s.fileIdx, episode)];
      const u = resolved[streamKey(s)]?.url;
      if (u && !isLoopback(u)) keys.push(httpKey(u));
      return keys;
    }
    return s.url ? [httpKey(s.url)] : [];
  };
  /** Audio languages of the file, when known (dub mode only: they override the release name). */
  const verifiedOf = (s: AddonStream) => (dubMode ? verifiedAudio(trackKeysOf(s), releaseFamily(s)) : null);
  // Language fit (VF / VOSTFR… per the user's preferences), lower is better.
  const langOf = (s: AddonStream) => langScore(s, langPrefs, verifiedOf(s));

  const ranked = useMemo(
    () => rankStreams(streams, {
      preferred: prefs.preferredQuality,
      addonOrder: addonList.map((a) => a.manifest.id),
      canResolveTorrents: !!resolverLabel,
      cached,
      lang: langOf,
      probed,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [streams, prefs.preferredQuality, addonList, resolverLabel, cached, probed, langPrefs, trackVer],
  );

  const [manual, setManual] = useState<string | undefined>();
  const [bad, setBad] = useState<string[]>([]);
  /** Auto source handed to the player: kept until it fails or is upgraded. */
  const [locked, setLocked] = useState<string | undefined>();
  /**
   * Switch decided by the source controller (`switchTo`): the source left and the URL it played,
   * kept on screen until the new one has its URL (a torrent is resolved first), then dropped.
   */
  const [switchFrom, setSwitchFrom] = useState<{ key: string; to: string; url: string } | null>(null);
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
  }, [ranked, bad, suspendedKeys, resolverLabel, cached, probed, prefs.preferredQuality, langPrefs, trackVer]);

  // ---- dub mode: dubbed candidates first, the others only once there is none ----
  // Torrents whose probe found nothing (no metadata, no peer) count as dead for the dub decision.
  const [deadSwarms, setDeadSwarms] = useState<{ scope: string; keys: string[] }>({ scope: peerScope, keys: [] });
  const deadSwarmKeys = deadSwarms.scope === peerScope ? deadSwarms.keys : [];
  /** Probably-dubbed candidates (by name) whose tracks showed no dub. */
  const rejectedMaybes = dubMode
    ? candidates.filter((s) => classifyDub(s, dubLangs).tier === 'maybe' && verifiedOf(s) && langOf(s) >= NOT_DUBBED).length
    : 0;
  const isDubbed = (s: AddonStream) => {
    const score = langOf(s);
    if (score >= NOT_DUBBED) return false;
    // Several untagged releases checked without a dub: the remaining untagged ones are not tried.
    return !(score === DUB_MAYBE && rejectedMaybes >= MAX_MAYBE_REJECTS && !verifiedOf(s) && !detectLangs(s).implied.length);
  };
  const aliveNow = (s: AddonStream) => {
    const k = streamKey(s);
    const u = raceUrlOf(s);
    return !(u && cachedRace(u)?.alive === false) && !wrongKeys.includes(k) && !deadSwarmKeys.includes(k);
  };
  const { dub: dubLive, other: otherLive } = dubMode ? splitDub(candidates, isDubbed, aliveNow) : { dub: [], other: [] };
  const [mountedAt] = useState(() => Date.now());
  /** Clock of the dub decision: moved by the timer below when the wait for slow addons ends. */
  const [phaseNow, setPhaseNow] = useState(mountedAt);
  const phaseInput = {
    dubMode,
    choice: dubChoice,
    autoFallback: dubAutoFallback,
    dubAlive: dubLive.length,
    verifying: false,
    addonsPending: pending,
    elapsedMs: phaseNow - mountedAt,
    knownNoDub: noDubKnown,
    fallbacks: otherLive.length,
  };
  const phase = dubPhase(phaseInput);
  // Waiting for slow addons before saying there is no dub: re-evaluate when the wait ends.
  const phaseWaits = dubWaitLeft(phaseInput) > 0;
  useEffect(() => {
    if (!phaseWaits) return;
    // From the screen's opening (the wait may start once the first other versions arrived).
    const left = mountedAt + (noDubKnown ? KNOWN_NO_DUB_WAIT_MS : DUB_WAIT_MS) - wallClock();
    const t = setTimeout(() => setPhaseNow(wallClock()), Math.max(0, left) + 20);
    return () => clearTimeout(t);
  }, [phaseWaits, noDubKnown, mountedAt]);
  /** Only dubbed candidates compete (race, torrent probes, start). */
  const restrictDub = phase === 'dub';
  /** No dub (yet): the other versions may be measured, but none starts before the user chose. */
  const holdOthers = dubMode && holdsStart(phase);
  const raceSet = raceCandidates(candidates, phase, isDubbed);

  // ---- cached torrents at the top: resolved ahead (debrid only) to be measured too ----
  const torrentKeys = enabled
    ? packKeys(raceSet.filter((s) => isTorrent(s) && cachedOf(s) === true).slice(0, RACE_TORRENTS).map(streamKey))
    : '';
  useEffect(() => {
    if (!torrentKeys || budget.max === 0) return;
    const ctrl = new AbortController();
    for (const k of unpackKeys(torrentKeys)) {
      const s = raceSet.find((x) => streamKey(x) === k);
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
  const entries: RaceEntry[] = raceSet.flatMap((s) => {
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
    const alive = raceSet.filter((s) => !deadKeys.has(streamKey(s)) && !wrongKeys.includes(streamKey(s)));
    // Only hosted players: the best of them (quality, then addon priority).
    const web = alive.length || restrictDub ? [] : ranked.filter((s) => !!autoWebPlayerUrl(s, probed) && !bad.includes(streamKey(s)) && !probing(s));
    return alive.some(safe) ? alive.filter(safe) : alive.length ? alive : web;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, deadKeys, ranked, probed, bad, wrongKeys, restrictDub, trackVer]);

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
  // Not the demo: once a real addon is added it steps aside (./builtin-demo.ts) and must not stay.
  const lockedStream = lockedListed ?? (locked && !bad.includes(locked) && lastLocked && streamKey(lastLocked) === locked && lastLocked.addonId !== BUILTIN_ID ? lastLocked : undefined);

  // ---- torrent race (on-device engine): uncached torrents probed in parallel ----
  const engineTorrent = (s: AddonStream) => isTorrent(s) && cachedOf(s) !== true;
  // Pre-search: probes (no piece) only on an unmetered network, where the winner is pre-warmed.
  const presearchProbes = preview && prewarmOk;
  const peerWanted =
    enabled && (!preview || presearchProbes) && !manual && !lockedStream && torrentBudget.base > 0 && canProbeTorrents() && pool.some(engineTorrent) && !pool.some(safe);
  const peerPool = peerWanted ? pool.filter(engineTorrent) : [];
  // Decided a moment ago for this episode (pre-search, previous visit): no new race.
  const recentWin = peerWins.get(peerScope);
  // `mountedAt` (when this screen opened, the tap): a race decided before it is reused, one
  // decided after is ours.
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
  /** Every probe ended, none playable: widen, take the best answering swarm, or the plain ranking. */
  const exhaustedNext = (probes: Record<string, PeerProbe>) => afterExhausted(peerCands(probes), widened === raceScope, torrentBudget.max);
  const peer = usePeerRace(raceScope, peerTargets, peerOn, (probes, at) => {
    const d = decidePeers(probes, at);
    if (d.key !== null) return true;
    return 'exhausted' in d && exhaustedNext(probes) !== 'widen';
  });
  const peerDecision = peerOn ? decidePeers(peer.probes, peer.startedAt) : null;
  const exhausted = peerDecision && peerDecision.key === null && 'exhausted' in peerDecision ? exhaustedNext(peer.probes) : null;
  // Never a blind start while unprobed candidates remain within the budget (adjusted during render).
  if (peerOn && exhausted === 'widen' && widened !== raceScope) setWidened(raceScope);
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
  // Dub mode: a dubbed torrent whose probe failed (no metadata / no peer) is not waited for.
  const newlyDead = dubMode ? Object.keys(peer.probes).filter((k) => peer.probes[k]?.state === 'failed' && !deadSwarmKeys.includes(k)) : [];
  if (newlyDead.length) setDeadSwarms({ scope: peerScope, keys: [...deadSwarmKeys, ...newlyDead] });

  // No verdict from the probes (none playable): the plain ranking, as before.
  const exhaustedKey = exhausted && exhausted !== 'widen' ? exhausted.key : undefined;
  const peerPick =
    presearched ??
    (peerDecision?.key ? pool.find((s) => streamKey(s) === peerDecision.key) : exhaustedKey ? pool.find((s) => streamKey(s) === exhaustedKey) : undefined);
  const peerPickKey = peerPick ? streamKey(peerPick) : undefined;
  useEffect(() => {
    if (peerPickKey && peerOn) peerWins.set(peerScope, { key: peerPickKey, at: wallClock(), fileIdx: peer.probes[peerPickKey]?.fileIdx });
    // Recorded when the race decides (the probes of that moment).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerPickKey, peerOn, peerScope]);
  const autoPick = peerPick ?? (peerWaitMs || (peerOn && exhausted === 'widen') ? undefined : decision?.key ? pool.find((s) => streamKey(s) === decision.key) : undefined);

  // ---- dub mode: check the tracks of a probably-dubbed pick before it starts ----
  const engineFileOf = (s: AddonStream) => s.fileIdx ?? peer.probes[streamKey(s)]?.fileIdx ?? swarmCheck(s.infoHash!)?.fileIdx ?? undefined;
  /** How the tracks of `s` can be read before it starts: 'http', 'engine', or null. */
  const sniffWay = (s: AddonStream): 'http' | 'engine' | null => {
    if (raceUrlOf(s)) return 'http';
    if (engineTorrent(s) && canProbeTorrents() && prewarmOk) return 'engine';
    return null;
  };
  const unverifiedMaybe = (s: AddonStream) => langOf(s) === DUB_MAYBE && !verifiedOf(s) && !!sniffWay(s) && !sniffFailed(trackKeysOf(s));
  const pickNeedsCheck = !!autoPick && restrictDub && !manual && !lockedStream && unverifiedMaybe(autoPick);
  // The pick, plus the next probably-dubbed torrents that answered their probe (checked in parallel).
  const answered = (s: AddonStream) => ['healthy', 'weak'].includes(peer.probes[streamKey(s)]?.state ?? '');
  const sniffList = enabled && restrictDub && !manual && !lockedStream
    ? [
        ...(pickNeedsCheck ? [autoPick!] : []),
        ...peerPool.filter((s) => s !== autoPick && unverifiedMaybe(s) && sniffWay(s) === 'engine' && answered(s)).slice(0, SNIFF_AHEAD),
      ]
    : [];
  const sniffKeys = packKeys(sniffList.map(streamKey));
  useEffect(() => {
    for (const s of sniffList) {
      const family = releaseFamily(s);
      const way = sniffWay(s);
      if (way === 'http') void sniffHttp(raceUrlOf(s)!, headersOf(s), family);
      else if (way === 'engine') {
        const name = s.behaviorHints?.filename ?? s.title?.split('\n')[0];
        void sniffTorrent(trackKeysOf(s)[0], { infoHash: s.infoHash!, fileIdx: engineFileOf(s), sources: s.sources, name }, family);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sniffKeys]);
  // What the race's own probe bytes taught about a link: shared with its release family (the next
  // episode of the same release is known at once).
  const learnedKeys = dubMode ? packKeys(raceSet.filter((s) => trackEntry(trackKeysOf(s)[0] ?? '')?.state === 'done').map(streamKey)) : '';
  useEffect(() => {
    for (const k of unpackKeys(learnedKeys)) {
      const s = raceSet.find((x) => streamKey(x) === k);
      if (s) linkFamily(trackKeysOf(s), releaseFamily(s));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [learnedKeys]);
  const auto = holdOthers || pickNeedsCheck ? undefined : autoPick;

  const current = (manual ? ranked.find((s) => streamKey(s) === manual) : undefined) ?? lockedStream ?? auto;
  const currentKey = current ? streamKey(current) : undefined;
  const webUrl = current ? webOf(current) : null;
  const ownUrl = current && !webUrl ? playUrlOf(current) : undefined;
  // Controller switch to a source still being resolved (torrent): the player keeps the old URL
  // until the new one is ready, then the new one loads at the same position.
  const switching = !!switchFrom && switchFrom.to === currentKey && !ownUrl;
  if (switchFrom && !switching) setSwitchFrom(null);
  const url = ownUrl ?? (switching ? switchFrom!.url : undefined);
  useEffect(() => {
    const group = current?.behaviorHints?.bingeGroup;
    if (enabled && !preview && (url || webUrl) && group) lastBinge.set(seriesId, group);
  }, [enabled, preview, url, webUrl, current, seriesId]);
  // The auto source reached the native player: keep it (no reload when better answers arrive
  // later; upgrades go through `upgrade`). Hosted pages are not kept: a direct link showing up
  // later still replaces them. Adjusted during render ("state from previous render" pattern).
  if (enabled && !manual && !lockedStream && currentKey && url && locked !== currentKey) setLocked(currentKey);

  /**
   * `final`: the source is wrong whatever its link (another work, see the source controller): no
   * second chance with fresh addon answers.
   */
  const markBad = (k: string, error?: string, final = false) => {
    const s = ranked.find((x) => streamKey(x) === k) ?? (lastLocked && streamKey(lastLocked) === k ? lastLocked : undefined);
    // The target of a controller switch failed before playing: back to the source it left.
    if (switchFrom && switchFrom.to === k) {
      setBad((b) => (b.includes(k) ? b : [...b, k]));
      setLocked(switchFrom.key);
      setSwitchFrom(null);
      return;
    }
    // Link from the disk cache: maybe just expired. Ask the addons again, then retry once.
    if (!final && s?.cachedAt != null && !retried.current.has(k)) {
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
    const fileIdx =
      current.fileIdx ?? peer.probes[currentKey]?.fileIdx ?? (recentWin?.key === currentKey ? recentWin.fileIdx : undefined) ?? swarmCheck(current.infoHash!)?.fileIdx ?? undefined;
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
  const prewarm = presearchProbes && peerPick && auto === peerPick && engineTorrent(peerPick) ? peerPick : undefined;
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

  // ---- source controller view (addons/source-controller.ts, wired by use-source-controller.ts) ----
  // Every alive candidate (not only the start pool: a probed healthy swarm may relieve a stalling
  // link), with its latest HTTP probe or swarm probe.
  const swarmOf = (s: AddonStream, now: number, clock: number): CtlCandidate['swarm'] => {
    const check = swarmCheck(s.infoHash!);
    const p = peer.probes[streamKey(s)];
    const pAt = p?.doneAtMs != null && peer.startedAt != null ? now - (clock - (peer.startedAt + p.doneAtMs)) : undefined;
    if (p && pAt != null && p.state !== 'cancelled' && (!check || pAt > check.at)) {
      return { connected: p.connected, healthy: p.state === 'healthy', local: p.local, failed: p.state === 'failed' || p.state === 'noFile', at: pAt };
    }
    return check ? { connected: check.connected, healthy: check.healthy, local: check.local, failed: check.failed, at: check.at } : undefined;
  };
  const ctlOf = (s: AddonStream, now: number, clock: number): CtlCandidate => {
    const tor = engineTorrent(s);
    const u = raceUrlOf(s);
    const r = u ? race.results[u] : undefined;
    return {
      key: streamKey(s),
      kind: tor ? 'torrent' : 'http',
      lang: langOf(s),
      resolution: detectQuality(s) ?? 0,
      quality: qualityOf(s),
      bitrateMbps: bitrateOf(s),
      bingeGroup: s.behaviorHints?.bingeGroup,
      http: !tor && r ? { speed: speedVerdict(r, bitrateOf(s)), mbps: r.mbps, ttfbMs: r.ttfbMs, at: r.at } : undefined,
      swarm: tor ? swarmOf(s, now, clock) : undefined,
      probeable: tor ? canProbeTorrents() : !!u,
      web: !!webOf(s),
    };
  };
  const controllable = enabled && !preview && !manual && !!current && !!ownUrl && !webUrl;
  /** Read by the controller on its own timer (not during render: probe ages use the clock). */
  const controllerView = (now: number, clock: number) => ({
    /** The playing source as the controller sees it (null: nothing to control). */
    current: controllable && current
      ? ({
          key: streamKey(current),
          kind: engineHashOf(ownUrl) ? 'torrent' : 'http',
          lang: langOf(current),
          resolution: detectQuality(current) ?? 0,
          quality: qualityOf(current),
          bitrateMbps: bitrateOf(current),
          bingeGroup: current.behaviorHints?.bingeGroup,
        } satisfies CurrentSource)
      : null,
    /** Name of the playing release says recap / special / compilation (no length check). */
    exempt: !!current && EXEMPT_NAME.test(`${current.name ?? ''} ${current.title ?? ''} ${current.behaviorHints?.filename ?? ''}`),
    /** Episodes in the playing file ("E01-02"). */
    episodes: current ? episodesInName(`${current.title ?? ''} ${current.behaviorHints?.filename ?? ''}`) : 1,
    candidates: controllable
      ? candidates.filter((s) => streamKey(s) !== currentKey && !deadKeys.has(streamKey(s)) && !wrongKeys.includes(streamKey(s))).map((s) => ctlOf(s, now, clock))
      : [],
  });
  /** Link to warm for a seamless switch (direct / debrid-resolved links only). */
  const warmTarget = (key: string): SourceUpgrade | null => {
    const s = ranked.find((x) => streamKey(x) === key);
    const u = s ? raceUrlOf(s) : undefined;
    return s && u ? { key, uri: u, headers: headersOf(s), quality: detectQuality(s) } : null;
  };
  /** Measure these candidates again (HTTP ranged GET / engine swarm probe). */
  const reprobe = (keys: string[]) => {
    const http: RaceEntry[] = [];
    const swarms: Parameters<typeof checkSwarms>[0] = [];
    for (const k of keys) {
      const s = ranked.find((x) => streamKey(x) === k);
      if (!s) continue;
      if (engineTorrent(s)) {
        swarms.push({ infoHash: s.infoHash!, sources: s.sources, name: s.behaviorHints?.filename ?? s.title?.split('\n')[0], fileIdx: s.fileIdx, filename: s.behaviorHints?.filename, episode });
      } else {
        const u = raceUrlOf(s);
        if (u) http.push({ url: u, headers: headersOf(s) });
      }
    }
    if (http.length) void remeasure(http, budget).catch(() => {});
    if (swarms.length && canProbeTorrents()) checkSwarms(swarms);
  };
  /** Controller switch at the current position (a short reload; a torrent is resolved first). */
  const switchTo = (key: string) => {
    if (manual || !currentKey || key === currentKey) return;
    if (ownUrl) setSwitchFrom({ key: currentKey, to: key, url: ownUrl });
    setLocked(key);
  };

  /** The player now plays `key` (seamless swap done). */
  const adoptUpgrade = (key: string) => setLocked(key);
  /**
   * An upgrade could not happen without interrupting (other engine, stalled…): keep playing, and
   * prefer that release for the next episode.
   */
  const deferUpgrade = (key: string) => {
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
    racing: !current && race.probing.size > 0 && phase !== 'missing',
    /** Torrent race: the engine is looking for peers before one torrent is started. */
    peerRacing: !current && peerWaitMs > 0 && phase !== 'missing',
    /** Playable candidates exist and one is about to be picked (race grace window, deadline). */
    deciding: !current && pool.length > 0 && phase !== 'missing',
    /**
     * Dub mode (./dub.ts): where the search for a dubbed source stands, and what to offer when
     * there is none (`fallback`: the name of the best other version, "VOSTFR"…).
     */
    dub: {
      mode: dubMode,
      phase,
      choice: dubChoice,
      lang: dubLangs[0] ?? 'fr',
      fallback: otherLive[0] ? fallbackName(otherLive[0], subLangs, autoTranslateSubs) : null,
      /** What plays is a dubbed (or probably dubbed) source. */
      playing: !!current && dubMode && isDubbed(current),
      /** A probably-dubbed source's tracks are being checked before it starts. */
      checking: pickNeedsCheck,
    },
    /** Keys of what we know of a stream's file tracks (the player's list is recorded under them). */
    trackKeysOf,
    /** Links measured / dead so far (sources menu summary). */
    raceStats: { measured: Object.keys(race.results).length, dead: deadKeys.size, enabled: budget.max > 0 },
    /** Addon status rows (not videos), see `infoKind`. */
    infos,
    resolverLabel,
    cachedOf,
    errorOf: (s: AddonStream) => resolved[streamKey(s)]?.error,
    stateOf,
    speedInfo,
    controllerView,
    /** The playing URL is served by the built-in torrent engine. */
    playingTorrent: !!engineHashOf(ownUrl),
    warmTarget,
    reprobe,
    switchTo,
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
