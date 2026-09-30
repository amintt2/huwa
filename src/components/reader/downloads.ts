// Offline chapters: pages are saved under <documents>/chapters/<chapterId>/ with expo-file-system
// (v57 object API: Paths / Directory / File.downloadFileAsync). Only file names are persisted —
// the app container path can change between installs, so URIs are rebuilt at runtime.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { remotePages } from './pageSource';

export type DownloadStatus = 'queued' | 'downloading' | 'done' | 'error';

export type DownloadEntry = {
  chapterId: string;
  seriesId: string;
  status: DownloadStatus;
  /** File names inside the chapter folder, in page order. */
  files: string[];
  total: number;
  saved: number;
  bytes: number;
  createdAt: number;
  error?: string;
};

type Downloads = Record<string, DownloadEntry>;

const KEY = 'huwa/downloads/v1';
const CONCURRENCY = 3;
export const downloadsSupported = Platform.OS !== 'web';

let state: Downloads = {};
const listeners = new Set<() => void>();
const controllers = new Map<string, AbortController>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function set(updater: (s: Downloads) => Downloads) {
  state = updater(state);
  listeners.forEach((l) => l());
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => AsyncStorage.setItem(KEY, JSON.stringify(state)).catch(() => {}), 300);
}

function patch(id: string, p: Partial<DownloadEntry>) {
  set((s) => (s[id] ? { ...s, [id]: { ...s[id], ...p } } : s));
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

AsyncStorage.getItem(KEY)
  .then((raw) => {
    if (!raw) return;
    const saved = JSON.parse(raw) as Downloads;
    // Interrupted downloads (app killed) are marked as errors so they can be resumed.
    for (const e of Object.values(saved)) {
      if (e.status === 'downloading' || e.status === 'queued') e.status = 'error';
    }
    state = { ...saved, ...state };
    listeners.forEach((l) => l());
  })
  .catch(() => {});

export const chapterDir = (chapterId: string) => new Directory(Paths.document, 'chapters', chapterId);

/** Local page URIs when the chapter is fully downloaded. */
export function offlinePages(chapterId: string): string[] | undefined {
  const e = state[chapterId];
  if (!downloadsSupported || e?.status !== 'done') return undefined;
  const dir = chapterDir(chapterId);
  return e.files.map((f) => new File(dir, f).uri);
}

export const useDownloads = () => useSyncExternalStore(subscribe, () => state, () => state);
export const useDownload = (chapterId: string) =>
  useSyncExternalStore(subscribe, () => state[chapterId], () => state[chapterId]);

const extOf = (url: string) => {
  const m = /\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.exec(url);
  return m ? m[1].toLowerCase() : 'jpg';
};

export async function downloadChapter(chapterId: string, seriesId: string) {
  if (!downloadsSupported || controllers.has(chapterId)) return;
  const ctrl = new AbortController();
  controllers.set(chapterId, ctrl);
  set((s) => ({
    ...s,
    [chapterId]: { chapterId, seriesId, status: 'queued', files: [], total: 0, saved: 0, bytes: 0, createdAt: Date.now() },
  }));
  try {
    const { pages, headers } = await remotePages(chapterId);
    if (!pages.length) throw new Error('Aucune page');
    const files = pages.map((u, i) => `${String(i).padStart(4, '0')}.${extOf(u)}`);
    const dir = chapterDir(chapterId);
    dir.create({ intermediates: true, idempotent: true });
    patch(chapterId, { status: 'downloading', files, total: pages.length });

    let next = 0;
    let saved = 0;
    const worker = async () => {
      while (next < pages.length) {
        if (ctrl.signal.aborted) throw new Error('Annulé');
        const i = next++;
        const target = new File(dir, files[i]);
        if (!(target.exists && target.size > 0)) {
          await File.downloadFileAsync(pages[i], target, { idempotent: true, headers, signal: ctrl.signal });
        }
        saved++;
        patch(chapterId, { saved });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pages.length) }, worker));
    patch(chapterId, { status: 'done', bytes: dir.size ?? 0, error: undefined });
  } catch (e) {
    if (ctrl.signal.aborted) {
      removeDownload(chapterId);
    } else {
      patch(chapterId, { status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    controllers.delete(chapterId);
  }
}

export function cancelDownload(chapterId: string) {
  const c = controllers.get(chapterId);
  if (c) c.abort();
  else removeDownload(chapterId);
}

export function removeDownload(chapterId: string) {
  try {
    const dir = chapterDir(chapterId);
    if (dir.exists) dir.delete();
  } catch {
    // already gone
  }
  set((s) => {
    const { [chapterId]: _gone, ...rest } = s;
    return rest;
  });
}

export function removeAllDownloads() {
  controllers.forEach((c) => c.abort());
  try {
    const root = new Directory(Paths.document, 'chapters');
    if (root.exists) root.delete();
  } catch {
    // ignore
  }
  set(() => ({}));
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} Ko`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} Mo`;
  return `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} Go`;
}
