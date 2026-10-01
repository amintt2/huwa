// Episode downloads: persisted state (queue items + settings) and file locations.
// Files live in <documents>/episodes/<seriesId>/<episodeId>/ (video.<ext>, sub-N.<ext>,
// meta.json). Only names relative to that folder are stored: the app container path changes
// between installs, so URIs are rebuilt at runtime (same rule as the manhwa chapter downloads).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import type { CompressMode } from './compress';
import { reduce, type DlEvent, type Items } from './queue';
import type { DlQuality, DownloadItem } from './types';

const KEY = 'huwa/episode-downloads/v1';
const SETTINGS_KEY = 'huwa/episode-downloads/settings/v1';
export const GB = 1024 ** 3;
export const DL_QUOTAS = [5 * GB, 10 * GB, 20 * GB, 50 * GB] as const;

export const downloadsSupported = Platform.OS !== 'web';

export type DlSettings = {
  quality: DlQuality;
  wifiOnly: boolean;
  quotaBytes: number;
  /** Delete downloads of episodes watched to the end. */
  autoDeleteWatched: boolean;
  /** On Wi-Fi, download the next episode of series in progress. */
  autoNext: boolean;
  compression: CompressMode;
  concurrency: number;
};

export const DEFAULT_DL_SETTINGS: DlSettings = {
  quality: 'auto',
  wifiOnly: true,
  quotaBytes: 10 * GB,
  autoDeleteWatched: false,
  autoNext: false,
  compression: 'off',
  concurrency: 2,
};

let items: Items = {};
let settings: DlSettings = DEFAULT_DL_SETTINGS;
let hydrated: Promise<void> | undefined;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function dispatch(e: DlEvent) {
  const next = reduce(items, e);
  if (next === items) return;
  items = next;
  emit();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => AsyncStorage.setItem(KEY, JSON.stringify(items)).catch(() => {}), 400);
}

export const getItems = () => items;
export const getItem = (id: string): DownloadItem | undefined => items[id];
export const getDlSettings = () => settings;

export function hydrateDownloads(): Promise<void> {
  if (!hydrated) {
    hydrated = Promise.all([AsyncStorage.getItem(KEY), AsyncStorage.getItem(SETTINGS_KEY)])
      .then(([raw, rawSettings]) => {
        if (raw) items = reduce({ ...(JSON.parse(raw) as Items), ...items }, { type: 'restore' });
        if (rawSettings) settings = { ...DEFAULT_DL_SETTINGS, ...(JSON.parse(rawSettings) as Partial<DlSettings>) };
      })
      .catch(() => {})
      .finally(emit);
  }
  return hydrated;
}

export function setDlSettings(patch: Partial<DlSettings>) {
  settings = { ...settings, ...patch };
  emit();
  AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)).catch(() => {});
}

export const useDownloadItems = () => useSyncExternalStore(subscribe, () => items, () => items);
export const useDownloadItem = (id: string) => useSyncExternalStore(subscribe, () => items[id], () => items[id]);
export const useDlSettings = () => useSyncExternalStore(subscribe, () => settings, () => settings);

// ---------- files ----------

export const rootDir = () => new Directory(Paths.document, 'episodes');
export const episodeDir = (i: Pick<DownloadItem, 'seriesId' | 'id'>) => new Directory(Paths.document, 'episodes', i.seriesId, i.id);
export const seriesDir = (seriesId: string) => new Directory(Paths.document, 'episodes', seriesId);

/** Absolute path of a file of the episode folder (`.movpkg` bundles are folders). */
export const pathIn = (i: Pick<DownloadItem, 'seriesId' | 'id'>, name: string) => new File(episodeDir(i), name);

export function ensureEpisodeDir(i: Pick<DownloadItem, 'seriesId' | 'id'>) {
  const d = episodeDir(i);
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

/** Media URI to play, when the download is complete and still on disk. */
export function localMediaUri(i: DownloadItem | undefined): string | undefined {
  if (!downloadsSupported || !i || i.status !== 'done' || !i.file) return undefined;
  try {
    if (i.file.endsWith('.movpkg')) {
      const d = new Directory(episodeDir(i), i.file);
      return d.exists ? d.uri : undefined;
    }
    const f = new File(episodeDir(i), i.file);
    return f.exists ? f.uri : undefined;
  } catch {
    return undefined;
  }
}

export function deleteEpisodeFiles(i: Pick<DownloadItem, 'seriesId' | 'id'>) {
  try {
    const d = episodeDir(i);
    if (d.exists) d.delete();
  } catch {
    // already gone
  }
}

/** Free space on the device (bytes), or Infinity when unknown. */
export function freeSpace(): number {
  try {
    return Paths.availableDiskSpace;
  } catch {
    return Infinity;
  }
}

export function formatBytes(n: number): string {
  if (!n || n < 0) return '0 o';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1).replace('.', ',')} ${u[i]}`;
}
