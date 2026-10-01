// Source selection for the player.
// Auto mode: play the first source that works as soon as one addon answers, then move to a
// better quality whenever one shows up (safe sources only: direct links or debrid-cached
// torrents). A source that fails is skipped; the last good one is the fallback.
// Manual mode: the user picked a source in the menu; a failure drops back to auto.
// Hosted player pages ("lecteurs web", see web-player.ts) are used by auto mode only when no
// native source exists; the page is then shown in the web player instead of the native one.
import { useEffect, useMemo, useState } from 'react';

import { useSettings } from '@/settings/settings';
import { resolveTorrent, useCachedHashes, useTorrentResolver } from '@/debrid/resolve';

import { langScore } from './audio';
import { isExternal, isPlayable, isTorrent, isYouTube, type AddonStream } from './protocol';
import { detectQuality, rankStreams, streamKey, type Quality } from './quality';
import { useAddonPrefs, useAddons, useStreams } from './registry';
import { autoWebPlayerUrl, hostOf, needsProbe, useProbedUrls, webPlayerUrl } from './web-player';

type Resolution = { url?: string; via?: string; error?: string };

export type SourceState = 'playing' | 'resolving' | 'failed' | 'ready' | 'needs-debrid' | 'youtube' | 'external' | 'web' | 'unusable';

// Stremio `bingeGroup`: the release last played for a series, preferred for its next episode
// (same group, same quality/subs/audio), as Stremio's binge-watching does.
const lastBinge = new Map<string, string>();
const NO_SUBS: NonNullable<AddonStream['subtitles']> = [];

/** `enabled: false` = idle (used to prefetch the next episode only once armed). */
export function useSource(seriesId: string, episode: number, { enabled = true }: { enabled?: boolean } = {}) {
  const { streams, infos, pending, failed } = useStreams(seriesId, episode, enabled);
  const prefs = useAddonPrefs();
  const { watchMode, subLangs, dubLangs } = useSettings();
  const langPrefs = useMemo(() => ({ watchMode, subLangs, dubLangs }), [watchMode, subLangs, dubLangs]);
  const addonList = useAddons();
  const resolverLabel = useTorrentResolver();
  const cached = useCachedHashes(streams.filter(isTorrent).map((s) => s.infoHash!));
  const probed = useProbedUrls(streams, enabled);

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

  /** Hosted player page of this stream, or null. */
  const webOf = (s: AddonStream) => webPlayerUrl(s, probed);
  const direct = (s: AddonStream) => isPlayable(s) && !webOf(s);
  /** Extension-less link whose headers are still being checked (could be a player page). */
  const probing = (s: AddonStream) => needsProbe(s) && !probed[s.url!];
  const usable = (s: AddonStream) => direct(s) || (isTorrent(s) && !!resolverLabel);
  const cachedOf = (s: AddonStream) => (isTorrent(s) ? cached[s.infoHash!.toLowerCase()] : undefined);
  /** Safe = expected to start quickly: direct link, or torrent already cached by the debrid service. */
  const safe = (s: AddonStream) => direct(s) || cachedOf(s) === true;

  // Auto choice, recomputed as answers arrive: best quality among safe sources, falling back
  // to unconfirmed torrents only when nothing safe exists. Ties keep the ranking order.
  const auto = useMemo(() => {
    const pref = prefs.preferredQuality;
    // Language fit first (VF / VOSTFR… per the user's preferences), then quality.
    const score = (s: AddonStream) => {
      let q = detectQuality(s) ?? 0;
      // Uncached torrent played by the on-device engine: speed depends on peers, not resolution.
      // 1080p is enough on a phone; the seeder count (Torrentio "👤 N") breaks ties.
      if (isTorrent(s) && cachedOf(s) !== true) {
        const seeds = Number(/👤\s*(\d+)/.exec(`${s.title ?? ''} ${s.description ?? ''}`)?.[1] ?? 0);
        q = Math.min(q, 1080) + Math.min(seeds, 500) / 1000;
        if (seeds && seeds < 3) q -= 400;
      }
      return -langScore(s, langPrefs) * 10_000 + (pref !== 'auto' && q > pref ? pref - (q - pref) / 10 : q);
    };
    const ok = (s: AddonStream) => !bad.includes(streamKey(s)) && !probing(s);
    const candidates = ranked.filter((s) => usable(s) && ok(s));
    // Only hosted players: the best of them (quality, then addon priority).
    const web = candidates.length ? [] : ranked.filter((s) => !!autoWebPlayerUrl(s, probed) && ok(s));
    const pool = candidates.some(safe) ? candidates.filter(safe) : candidates.length ? candidates : web;
    const binge = lastBinge.get(seriesId);
    const same = binge ? pool.find((s) => s.behaviorHints?.bingeGroup === binge) : undefined;
    if (same) return same;
    return pool.reduce<AddonStream | undefined>((best, s) => (!best || score(s) > score(best) ? s : best), undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranked, bad, resolverLabel, cached, probed, prefs.preferredQuality, seriesId, langPrefs]);

  const current = (manual ? ranked.find((s) => streamKey(s) === manual) : undefined) ?? auto;
  const currentKey = current ? streamKey(current) : undefined;
  const webUrl = current ? webOf(current) : null;
  const url = current && !webUrl ? (isPlayable(current) ? current.url : resolved[currentKey!]?.url) : undefined;
  useEffect(() => {
    const group = current?.behaviorHints?.bingeGroup;
    if (enabled && (url || webUrl) && group) lastBinge.set(seriesId, group);
  }, [enabled, url, webUrl, current, seriesId]);

  const markBad = (k: string, error?: string) => {
    setBad((b) => (b.includes(k) ? b : [...b, k]));
    if (error) setResolved((r) => ({ ...r, [k]: { ...r[k], error } }));
    setManual((m) => (m === k ? undefined : m));
  };

  // Torrent → HTTPS through the debrid service (or the native engine once registered).
  useEffect(() => {
    if (!enabled || !current || !currentKey || !isTorrent(current) || !resolverLabel || resolved[currentKey]) return;
    const ctrl = new AbortController();
    resolveTorrent(
      { infoHash: current.infoHash!, fileIdx: current.fileIdx, filename: current.behaviorHints?.filename, sources: current.sources, episode },
      ctrl.signal,
    )
      .then(({ url: u, via }) => setResolved((r) => ({ ...r, [currentKey]: { url: u, via } })))
      .catch((e) => {
        if (!ctrl.signal.aborted) markBad(currentKey, e instanceof Error ? e.message : 'Échec');
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, resolverLabel, enabled]);

  const pick = (s: AddonStream | 'auto') => {
    if (s === 'auto') return setManual(undefined);
    const k = streamKey(s);
    setBad((b) => b.filter((x) => x !== k));
    setResolved((m) => (m[k]?.error ? { ...m, [k]: {} } : m));
    setManual(k);
  };

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
    /** Addon status rows (not videos), see `infoKind`. */
    infos,
    resolverLabel,
    cachedOf,
    errorOf: (s: AddonStream) => resolved[streamKey(s)]?.error,
    stateOf,
    pick,
    markBad,
  };
}

export const qualityLabel = (q: Quality | null) => (q === 2160 ? '4K' : q ? `${q}p` : 'SD/?');
