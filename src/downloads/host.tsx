// Headless runner of the episode download queue, mounted once at the root (app/_layout.tsx).
//  - follows the network (Wi-Fi only items wait for Wi-Fi) and starts what the queue allows;
//  - resolves each item's source with the same addon search and ranking as the player
//    (<Resolver/>, one per item being resolved), then hands it to ./runner.ts;
//  - "Supprimer les épisodes vus", "Épisode suivant automatiquement sur Wi-Fi" and the
//    compression pass run from here too.
import { NetworkStateType, useNetworkState } from 'expo-network';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { Directory, File } from 'expo-file-system';

import { langScore } from '@/addons/audio';
import { isTorrent } from '@/addons/protocol';
import { rankStreams } from '@/addons/quality';
import { useAddonPrefs, useAddons, useStreams, useSubtitles } from '@/addons/registry';
import { useProbedUrls } from '@/addons/web-player';
import { getEpisode, getSeries, registerSeries, type Series } from '@/data/catalog';
import { resolveTorrent, useCachedHashes, useTorrentResolver } from '@/debrid/resolve';
import { getDebrid } from '@/debrid/store';
import { useSettings } from '@/settings/settings';
import { getState as getWatchState, useStore } from '@/store/store';
import { isDemo } from '@/demo/flags';
import { getTorrentSettings, isAvailable as torrentLinked } from '@/torrent';

import { enqueueEpisodes } from './index';
import { pickForDownload, pickSubtitles, sourceOf, whyNotDownloadable } from './pick';
import { autoNextEpisodes, isActive, nextRetryIn, startable, watchedDownloads } from './queue';
import { attachHls, compressNext, hlsAvailable, isRunning, removeDownload, runTransfer } from './runner';
import { dispatch, episodeDir, getItems, hydrateDownloads, rootDir, useDlSettings, useDownloadItems } from './store';
import type { DownloadItem, NetworkKind } from './types';

/** Longest wait for slow addons before choosing among the answers already there. */
const RESOLVE_PATIENCE_MS = 15_000;
const RESOLVE_TIMEOUT_MS = 40_000;

function networkKind(net: ReturnType<typeof useNetworkState>): NetworkKind {
  if (net.type === NetworkStateType.NONE || net.isConnected === false) return 'offline';
  if (net.type === NetworkStateType.CELLULAR) return 'cellular';
  // Wi-Fi, Ethernet, or a platform that cannot tell.
  return 'wifi';
}

export function DownloadsHost() {
  const [ready, setReady] = useState(false);
  const items = useDownloadItems();
  const settings = useDlSettings();
  const network = networkKind(useNetworkState());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    hydrateDownloads().then(() => {
      attachHls();
      restoreOfflineSeries();
      if (!isDemo) removeOrphans();
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (ready) dispatch({ type: 'network', network });
  }, [ready, network]);

  // Start what the queue allows; transfers for items already in 'downloading'.
  useEffect(() => {
    if (!ready) return;
    for (const id of startable(items, { now: Date.now(), network, concurrency: settings.concurrency })) dispatch({ type: 'start', id });
    for (const i of Object.values(items)) {
      if (i.status === 'downloading' && i.source?.url && !isRunning(i.id)) runTransfer(i);
    }
    const wait = nextRetryIn(items, Date.now());
    if (wait == null) return;
    const t = setTimeout(() => setTick((n) => n + 1), wait + 50);
    return () => clearTimeout(t);
  }, [ready, items, network, settings.concurrency, tick]);

  // Watched downloads, next episodes, compression: on launch, when the app comes back, every 5 min.
  const episodes = useStore((s) => s.episodes);
  const housekeeping = useRef<() => void>(() => {});
  useEffect(() => {
    housekeeping.current = () => {
    if (!ready) return;
    if (settings.autoDeleteWatched) {
      // Not the one just finished (the watch screen may still show it): 10 minutes later.
      const old = (id: string) => {
        const p = getWatchState().episodes[id];
        return !!p?.done && Date.now() - p.updatedAt > 10 * 60e3;
      };
      for (const id of watchedDownloads(getItems(), old)) removeDownload(id);
    }
    if (settings.autoNext && network === 'wifi') {
      const recent = Object.entries(episodes)
        .filter(([, p]) => Date.now() - p.updatedAt < 14 * 86400e3)
        .map(([id, p]) => ({ found: getEpisode(id), p }))
        .filter((x) => !!x.found);
      // Last episode watched (to the end) per series, five most recent series.
      const bySeries = new Map<string, { series: Series; last: number; at: number }>();
      for (const { found, p } of recent) {
        if (!p.done) continue;
        const cur = bySeries.get(found!.series.id);
        if (!cur || found!.episode.number > cur.last) bySeries.set(found!.series.id, { series: found!.series, last: found!.episode.number, at: Math.max(p.updatedAt, cur?.at ?? 0) });
      }
      const list = [...bySeries.values()].sort((a, b) => b.at - a.at).slice(0, 5);
      const todo = autoNextEpisodes(
        list.map((x) => ({ seriesId: x.series.id, episodes: x.series.anime?.episodes.map((e) => ({ id: e.id, number: e.number })) ?? [], lastWatched: x.last })),
        getItems(),
      );
      for (const t of todo) {
        const s = getSeries(t.seriesId);
        const e = s?.anime?.episodes.find((x) => x.id === t.id);
        if (s && e) enqueueEpisodes(s, e, 'one', { wifiOnly: true, auto: true });
      }
    }
    if (AppState.currentState === 'active') void compressNext();
    };
  });
  useEffect(() => {
    housekeeping.current();
  }, [ready, episodes, settings.autoDeleteWatched, settings.autoNext, settings.compression, network]);
  useEffect(() => {
    const t = setInterval(() => housekeeping.current(), 5 * 60e3);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && housekeeping.current());
    return () => {
      clearInterval(t);
      sub.remove();
    };
  }, []);
  // A pending compression starts as soon as the previous one ends.
  const pendingCompress = Object.values(items).some((i) => i.compress?.state === 'pending');
  const runningCompress = Object.values(items).some((i) => i.compress?.state === 'running');
  useEffect(() => {
    if (ready && pendingCompress && !runningCompress && AppState.currentState === 'active') void compressNext();
  }, [ready, pendingCompress, runningCompress]);

  const resolving = Object.values(items).filter((i) => i.status === 'resolving');
  return (
    <>
      {resolving.map((i) => (
        <Resolver key={i.id} item={i} />
      ))}
    </>
  );
}

/** Episode folders no download refers to (storage cleared, crash mid-delete): freed. */
function removeOrphans() {
  try {
    const root = rootDir();
    if (!root.exists) return;
    const known = getItems();
    for (const s of root.list()) {
      if (!(s instanceof Directory)) continue;
      for (const e of s.list()) if (!known[e.name]) e.delete();
      if (!s.list().length) s.delete();
    }
  } catch {
    // best effort
  }
}

/** Series of downloaded episodes missing from the catalog (offline launch): from meta.json. */
function restoreOfflineSeries() {
  const missing: Series[] = [];
  for (const i of Object.values(getItems())) {
    if (i.status !== 'done' || getSeries(i.seriesId) || missing.some((s) => s.id === i.seriesId)) continue;
    try {
      const f = new File(episodeDir(i), 'meta.json');
      if (!f.exists) continue;
      const meta = JSON.parse(f.textSync()) as { series?: Series | null };
      if (meta.series?.id) missing.push(meta.series);
    } catch {
      // unreadable meta: the episode stays listed in Téléchargements
    }
  }
  if (missing.length) registerSeries(missing);
}

/** Finds and resolves the source of one item, then reports it to the queue. Renders nothing. */
function Resolver({ item }: { item: DownloadItem }) {
  const { streams, pending, asked } = useStreams(item.seriesId, item.episode, true);
  const prefs = useAddonPrefs();
  const addons = useAddons();
  const { watchMode, subLangs, dubLangs } = useSettings();
  const resolverLabel = useTorrentResolver();
  const cached = useCachedHashes(streams.filter(isTorrent).map((s) => s.infoHash!));
  const probed = useProbedUrls(streams, true);
  const ranked = useMemo(
    () =>
      rankStreams(streams, {
        preferred: item.quality === 'auto' ? prefs.preferredQuality : item.quality,
        addonOrder: addons.map((a) => a.manifest.id),
        canResolveTorrents: !!resolverLabel,
        cached,
        lang: (s) => langScore(s, { watchMode, subLangs, dubLangs }),
        probed,
      }),
    [streams, item.quality, prefs.preferredQuality, addons, resolverLabel, cached, watchMode, subLangs, dubLangs, probed],
  );
  const subs = useSubtitles(item.seriesId, item.episode, true, null, subLangs);
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  const decided = useRef(false);

  const ctx = { debrid: !!getDebrid(), engine: torrentLinked() && getTorrentSettings().enabled, probed, hls: hlsAvailable() };
  const pick = pickForDownload(ranked, item.quality, ctx, item.preferredKey);
  const settled = pending === 0 || (elapsed > RESOLVE_PATIENCE_MS && !!pick) || elapsed > RESOLVE_TIMEOUT_MS;

  useEffect(() => {
    if (settled) return;
    const t = setTimeout(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearTimeout(t);
  });

  useEffect(() => {
    if (!settled || decided.current) return;
    decided.current = true;
    const id = item.id;
    const now = Date.now();
    if (!pick) {
      const none = asked === 0;
      dispatch({
        type: 'fail',
        id,
        now,
        // No source yet may change later (addons down, episode just aired): retried with backoff.
        retryable: !none && streams.length === 0,
        error: none ? 'Aucune extension vidéo installée.' : streams.length ? whyNotDownloadable(ranked, ctx) : 'Aucune source trouvée pour cet épisode.',
      });
      return;
    }
    const subtitleSources = item.subtitleSources ?? pickSubtitles(subs, subLangs).map((s) => ({ url: s.url, lang: s.lang, label: s.addonName }));
    const s = pick.stream;
    const finish = (url: string, via?: string) => {
      const loop = /^https?:\/\/(127\.|localhost[:/])/i.test(url);
      if (!isActive(getItems()[id] ?? ({ status: 'done' } as DownloadItem))) return;
      dispatch({ type: 'patch', id, patch: { subtitleSources } });
      dispatch({ type: 'resolved', id, source: sourceOf(s, url, via), kind: pick.kind === 'hls' ? 'hls' : loop ? 'torrent' : 'file' });
    };
    if (isTorrent(s)) {
      resolveTorrent({ infoHash: s.infoHash!, fileIdx: s.fileIdx, filename: s.behaviorHints?.filename, sources: s.sources, episode: item.episode })
        .then((r) => finish(r.url, r.via))
        .catch((e) => dispatch({ type: 'fail', id, now: Date.now(), retryable: true, error: e instanceof Error ? e.message : 'Torrent non résolu' }));
      return;
    }
    finish(s.url!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);

  return null;
}
