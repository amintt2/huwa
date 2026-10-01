// Offline episodes — public API for screens.
//   enqueueEpisodes(...)   "Télécharger", "les N suivants", "la saison"
//   pauseDownload / resumeDownload (also "Réessayer") / removeDownload / removeSeries / removeAll
//   useOfflineEpisode(id)  local file + subtitles when the episode is downloaded (watch screen)
// The queue runs in <DownloadsHost /> (./host.tsx), mounted once at the root.
import { useMemo } from 'react';
import { File } from 'expo-file-system';

import type { AddonStream } from '@/addons/protocol';
import { getSeries, type Episode, type Series } from '@/data/catalog';

import { planEpisodes } from './queue';
import { sourceOf, type Pick } from './pick';
import { dispatch, episodeDir, getDlSettings, getItems, localMediaUri, useDownloadItem } from './store';
import { removeDownload } from './runner';
import type { DlQuality } from './types';

export { pauseDownload, removeDownload, resumeDownload, compressionAvailable, compressionBlocked, hlsAvailable } from './runner';
export {
  DL_QUOTAS,
  downloadsSupported,
  formatBytes,
  getDlSettings,
  getItem,
  getItems,
  setDlSettings,
  useDlSettings,
  useDownloadItem,
  useDownloadItems,
  type DlSettings,
} from './store';
export type { DlQuality, DownloadItem, DlStatus } from './types';

export type EnqueueMode = 'one' | 'next' | 'season';

export type EnqueueOptions = {
  quality?: DlQuality;
  wifiOnly?: boolean;
  /** "les N suivants". */
  count?: number;
  /** Watch screen: the source playing now (auto or manual pick) and its resolved link. */
  playing?: { stream: AddonStream; url?: string; via?: string; pick?: Pick | null };
  /** Watch screen: subtitle files to save with the episode. */
  subtitles?: { url: string; lang: string; label?: string }[];
  auto?: boolean;
};

/** Queues episodes of a series; returns how many were added. */
export function enqueueEpisodes(series: Series, from: Episode, mode: EnqueueMode, opts: EnqueueOptions = {}): number {
  const eps = series.anime?.episodes ?? [];
  const settings = getDlSettings();
  const ids = planEpisodes(eps.map((e) => ({ id: e.id, number: e.number })), from.number, mode, getItems(), opts.count ?? 3);
  const quality = opts.quality ?? settings.quality;
  const playing = opts.playing;
  dispatch({
    type: 'enqueue',
    now: Date.now(),
    items: ids.map((id) => {
      const e = eps.find((x) => x.id === id)!;
      const isCurrent = e.id === from.id && !!playing;
      // The playing source is reused as is for this episode when it fits the asked quality.
      const reuse = isCurrent && playing!.pick && playing!.pick.stream === playing!.stream && (quality === 'auto' || playing!.pick.exact);
      return {
        id,
        seriesId: series.id,
        episode: e.number,
        seriesTitle: series.title,
        title: e.title ? `Ép. ${e.number} — ${e.title}` : `Épisode ${e.number}`,
        durationMin: e.durationMin,
        image: series.image,
        quality,
        wifiOnly: opts.wifiOnly ?? settings.wifiOnly,
        // Next episodes: same release (binge group) preferred through the key of the playing one.
        preferredKey: playing ? sourceOf(playing.stream).key : undefined,
        source: reuse && playing!.url ? sourceOf(playing!.stream, playing!.url, playing!.via) : undefined,
        kind: reuse ? (playing!.pick!.kind === 'torrent' && playing!.url && !/127\.0\.0\.1|localhost/.test(playing!.url) ? 'file' : playing!.pick!.kind) : undefined,
        subtitleSources: isCurrent ? opts.subtitles : undefined,
        auto: opts.auto,
      };
    }),
  });
  return ids.length;
}

export function removeSeries(seriesId: string) {
  for (const i of Object.values(getItems())) if (i.seriesId === seriesId) removeDownload(i.id);
}

export function removeAll() {
  for (const id of Object.keys(getItems())) removeDownload(id);
}

export type OfflineEpisode = { uri: string; subtitles: { url: string; lang: string; label?: string }[] };

/** Local copy of an episode (complete and on disk), or null. */
export function useOfflineEpisode(id: string): OfflineEpisode | null {
  const item = useDownloadItem(id);
  return useMemo(() => {
    const uri = localMediaUri(item);
    if (!item || !uri) return null;
    const dir = episodeDir(item);
    const subtitles = item.subtitles
      .map((s) => ({ f: new File(dir, s.file), s }))
      .filter((x) => x.f.exists)
      .map(({ f, s }) => ({ url: f.uri, lang: s.lang, label: s.label }));
    return { uri, subtitles };
  }, [item]);
}

export const seriesOfDownload = (seriesId: string) => getSeries(seriesId);
