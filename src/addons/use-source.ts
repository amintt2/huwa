// Source selection for the player.
// Auto mode: play the first source that works as soon as one addon answers, then move to a
// better quality whenever one shows up (safe sources only: direct links or debrid-cached
// torrents). A source that fails is skipped; the last good one is the fallback.
// Manual mode: the user picked a source in the menu; a failure drops back to auto.
import { useEffect, useMemo, useState } from 'react';

import { resolveTorrent, useCachedHashes, useTorrentResolver } from '@/debrid/resolve';

import { isPlayable, isTorrent, type AddonStream } from './protocol';
import { detectQuality, rankStreams, streamKey, type Quality } from './quality';
import { useAddonPrefs, useAddons, useStreams } from './registry';

type Resolution = { url?: string; via?: string; error?: string };

export type SourceState = 'playing' | 'resolving' | 'failed' | 'ready' | 'needs-debrid' | 'external' | 'unusable';

export function useSource(seriesId: string, episode: number) {
  const { streams, pending, failed } = useStreams(seriesId, episode);
  const prefs = useAddonPrefs();
  const addonList = useAddons();
  const resolverLabel = useTorrentResolver();
  const cached = useCachedHashes(streams.filter(isTorrent).map((s) => s.infoHash!));

  const ranked = useMemo(
    () => rankStreams(streams, {
      preferred: prefs.preferredQuality,
      addonOrder: addonList.map((a) => a.manifest.id),
      canResolveTorrents: !!resolverLabel,
      cached,
    }),
    [streams, prefs.preferredQuality, addonList, resolverLabel, cached],
  );

  const [manual, setManual] = useState<string | undefined>();
  const [bad, setBad] = useState<string[]>([]);
  const [resolved, setResolved] = useState<Record<string, Resolution>>({});

  const usable = (s: AddonStream) => isPlayable(s) || (isTorrent(s) && !!resolverLabel);
  const cachedOf = (s: AddonStream) => (isTorrent(s) ? cached[s.infoHash!.toLowerCase()] : undefined);
  /** Safe = expected to start quickly: direct link, or torrent already cached by the debrid service. */
  const safe = (s: AddonStream) => isPlayable(s) || cachedOf(s) === true;

  // Auto choice, recomputed as answers arrive: best quality among safe sources, falling back
  // to unconfirmed torrents only when nothing safe exists. Ties keep the ranking order.
  const auto = useMemo(() => {
    const pref = prefs.preferredQuality;
    const score = (s: AddonStream) => {
      const q = detectQuality(s) ?? 0;
      return pref !== 'auto' && q > pref ? pref - (q - pref) / 10 : q;
    };
    const candidates = ranked.filter((s) => usable(s) && !bad.includes(streamKey(s)));
    const pool = candidates.some(safe) ? candidates.filter(safe) : candidates;
    return pool.reduce<AddonStream | undefined>((best, s) => (!best || score(s) > score(best) ? s : best), undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranked, bad, resolverLabel, cached, prefs.preferredQuality]);

  const current = (manual ? ranked.find((s) => streamKey(s) === manual) : undefined) ?? auto;
  const currentKey = current ? streamKey(current) : undefined;
  const url = current ? (isPlayable(current) ? current.url : resolved[currentKey!]?.url) : undefined;

  const markBad = (k: string, error?: string) => {
    setBad((b) => (b.includes(k) ? b : [...b, k]));
    if (error) setResolved((r) => ({ ...r, [k]: { ...r[k], error } }));
    setManual((m) => (m === k ? undefined : m));
  };

  // Torrent → HTTPS through the debrid service (or the native engine once registered).
  useEffect(() => {
    if (!current || !currentKey || !isTorrent(current) || !resolverLabel || resolved[currentKey]) return;
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
  }, [currentKey, resolverLabel]);

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
    if (k === currentKey) return url ? 'playing' : 'resolving';
    if (usable(s)) return 'ready';
    if (isTorrent(s)) return 'needs-debrid';
    if (s.externalUrl) return 'external';
    return 'unusable';
  };

  return {
    ranked,
    current,
    currentKey,
    url,
    headers: current?.behaviorHints?.proxyHeaders?.request,
    quality: current ? detectQuality(current) : null,
    auto: !manual,
    pending,
    failed,
    resolverLabel,
    cachedOf,
    errorOf: (s: AddonStream) => resolved[streamKey(s)]?.error,
    stateOf,
    pick,
    markBad,
  };
}

export const qualityLabel = (q: Quality | null) => (q === 2160 ? '4K' : q ? `${q}p` : 'SD/?');
