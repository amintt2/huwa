// Offline chapters: pages are saved under <documents>/chapters/<chapterId>/ with expo-file-system
// (v57 object API: Paths / Directory / File.downloadFileAsync), in their original format (no
// re-encoding: the source's JPEG/WebP is already the smallest copy we can get). Only file names
// are persisted — the app container path can change between installs, so URIs are rebuilt.
//
// The queue logic (states, order, scheduling) is the pure state machine of `download-queue.ts`;
// this module does the I/O: page lists, files, network policy ("Wi-Fi uniquement"), persistence.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { addNetworkStateListener, getNetworkStateAsync, NetworkStateType, type NetworkState } from 'expo-network';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { getChapter } from '@/data/catalog';

import { bySeries, isActive, nextChapters, nextToStart, reduce, type DownloadEntry, type Downloads, type QueueEvent } from './download-queue';
import { remotePages } from './pageSource';

export type { DownloadEntry, DownloadStatus, SeriesDownloads } from './download-queue';

export type DownloadPrefs = {
  /** Only download on Wi-Fi / Ethernet (the queue waits otherwise). */
  wifiOnly: boolean;
  /** When a chapter is opened, fetch the next ones in the background (Wi-Fi only). */
  autoNext: boolean;
  autoCount: number;
};

const KEY = 'huwa/downloads/v1';
const PREFS_KEY = 'huwa/downloads/prefs/v1';
/** Chapters downloaded at the same time, and pages per chapter. */
const CHAPTERS_AT_ONCE = 2;
const PAGES_AT_ONCE = 3;
export const downloadsSupported = Platform.OS !== 'web';

let state: Downloads = {};
let prefs: DownloadPrefs = { wifiOnly: false, autoNext: false, autoCount: 3 };
let net: Pick<NetworkState, 'type' | 'isConnected'> = { type: NetworkStateType.UNKNOWN, isConnected: true };
const listeners = new Set<() => void>();
const controllers = new Map<string, AbortController>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let version = 0;

const notify = () => {
  version++;
  listeners.forEach((l) => l());
};

function dispatch(ev: QueueEvent) {
  const next = reduce(state, ev);
  if (next === state) return;
  state = next;
  notify();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => AsyncStorage.setItem(KEY, JSON.stringify(state)).catch(() => {}), 400);
  if (ev.type !== 'progress') pump();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

// ---------- network policy ----------

const UNMETERED = [NetworkStateType.WIFI, NetworkStateType.ETHERNET];
const offline = () => net.type === NetworkStateType.NONE || net.isConnected === false;
/** Web and unknown types can't tell Wi-Fi from cellular: don't block there. */
const onWifi = () => !net.type || net.type === NetworkStateType.UNKNOWN || UNMETERED.includes(net.type);

export type QueueBlock = 'offline' | 'wifi-only' | null;
function blockReason(): QueueBlock {
  if (offline()) return 'offline';
  if (prefs.wifiOnly && !onWifi()) return 'wifi-only';
  return null;
}

/** Stops running downloads (they stay queued) when the network stops allowing them. */
function requeueRunning() {
  for (const [id, c] of controllers) {
    dispatch({ type: 'pause', chapterId: id });
    c.abort();
    dispatch({ type: 'resume', chapterId: id });
  }
}

function onNetwork(s: Pick<NetworkState, 'type' | 'isConnected'>) {
  net = s;
  notify();
  if (blockReason()) requeueRunning();
  else pump();
}

if (downloadsSupported) {
  getNetworkStateAsync().then(onNetwork, () => {});
  try {
    addNetworkStateListener(onNetwork);
  } catch {
    // no listener on this platform: state read at launch only
  }
}

// ---------- persistence ----------

let hydrated = false;
Promise.all([AsyncStorage.getItem(KEY), AsyncStorage.getItem(PREFS_KEY)])
  .then(([raw, rawPrefs]) => {
    if (rawPrefs) prefs = { ...prefs, ...(JSON.parse(rawPrefs) as Partial<DownloadPrefs>) };
    hydrated = true;
    if (raw) dispatch({ type: 'restore', saved: JSON.parse(raw) as Downloads });
    else notify();
    pump();
  })
  .catch(() => {
    hydrated = true;
  });

export const getDownloadPrefs = () => prefs;
export function setDownloadPref<K extends keyof DownloadPrefs>(key: K, value: DownloadPrefs[K]) {
  prefs = { ...prefs, [key]: value };
  notify();
  AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs)).catch(() => {});
  if (blockReason()) requeueRunning();
  else pump();
}

// ---------- files ----------

export const chapterDir = (chapterId: string) => new Directory(Paths.document, 'chapters', chapterId);

/** Local page URIs when the chapter is fully downloaded. */
export function offlinePages(chapterId: string): string[] | undefined {
  const e = state[chapterId];
  if (!downloadsSupported || e?.status !== 'done') return undefined;
  const dir = chapterDir(chapterId);
  return e.files.map((f) => new File(dir, f).uri);
}

const extOf = (url: string) => {
  const m = /\.(jpe?g|png|webp|gif|avif|heic)(?:[?#]|$)/i.exec(url);
  return m ? m[1].toLowerCase() : 'jpg';
};

function deleteFiles(chapterId: string) {
  try {
    const dir = chapterDir(chapterId);
    if (dir.exists) dir.delete();
  } catch {
    // already gone
  }
}

// ---------- worker ----------

async function run(chapterId: string) {
  const ctrl = new AbortController();
  controllers.set(chapterId, ctrl);
  try {
    const { pages, headers, origin, error } = await remotePages(chapterId);
    if (!pages.length) throw new Error(error ?? 'Aucune page');
    if (origin === 'offline') throw new Error('Déjà hors-ligne');
    if (ctrl.signal.aborted) return;
    const files = pages.map((u, i) => `${String(i).padStart(4, '0')}.${extOf(u)}`);
    const dir = chapterDir(chapterId);
    dir.create({ intermediates: true, idempotent: true });
    dispatch({ type: 'pages', chapterId, files });

    let next = 0;
    let saved = 0;
    const worker = async () => {
      while (next < pages.length) {
        if (ctrl.signal.aborted) throw new Error('Annulé');
        const i = next++;
        const target = new File(dir, files[i]);
        // Resuming a paused chapter: pages already on disk are kept.
        if (!(target.exists && (target.size ?? 0) > 0)) {
          await File.downloadFileAsync(pages[i], target, { idempotent: true, headers, signal: ctrl.signal } as Parameters<typeof File.downloadFileAsync>[2]);
        }
        saved++;
        dispatch({ type: 'progress', chapterId, saved });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAGES_AT_ONCE, pages.length) }, worker));
    dispatch({ type: 'done', chapterId, bytes: dir.size ?? 0 });
  } catch (e) {
    // Paused / cancelled: the reducer ignores a failure of an entry that isn't downloading.
    if (!ctrl.signal.aborted) dispatch({ type: 'fail', chapterId, error: e instanceof Error ? e.message : String(e) });
  } finally {
    if (controllers.get(chapterId) === ctrl) controllers.delete(chapterId);
    pump();
  }
}

function pump() {
  if (!downloadsSupported || !hydrated) return;
  for (const id of nextToStart(state, { concurrency: CHAPTERS_AT_ONCE, allowed: !blockReason() })) {
    if (controllers.has(id)) continue;
    dispatch({ type: 'start', chapterId: id });
    run(id);
  }
}

// ---------- public API ----------

export const useDownloads = () => useSyncExternalStore(subscribe, () => state, () => state);
export const useDownload = (chapterId: string) => useSyncExternalStore(subscribe, () => state[chapterId], () => state[chapterId]);
export const getDownloads = () => state;
export const downloadsBySeries = () => bySeries(state);

/** Prefs and why the queue is waiting (`null` when it runs). */
export function useDownloadQueue(): { prefs: DownloadPrefs; blocked: QueueBlock } {
  useSyncExternalStore(subscribe, () => version, () => version);
  return { prefs, blocked: blockReason() };
}

/** Queues chapters (in the given order). Already downloaded / queued chapters are skipped. */
export function enqueueChapters(seriesId: string, chapterIds: string[]) {
  if (!downloadsSupported) return;
  const at = Date.now();
  for (const chapterId of chapterIds) dispatch({ type: 'enqueue', chapterId, seriesId, at });
}

export const downloadChapter = (chapterId: string, seriesId: string) => enqueueChapters(seriesId, [chapterId]);

/** "Télécharger les N suivants" from a chapter (included) — or the whole series. */
export function downloadNext(seriesId: string, fromChapterId: string | null, count: number) {
  const ids = getChapter(fromChapterId ?? '')?.series.manhwa?.chapters.map((c) => c.id);
  if (!ids) return 0;
  const todo = nextChapters(ids, fromChapterId, count, state, { includeFrom: true });
  enqueueChapters(seriesId, todo);
  return todo.length;
}

export function downloadSeries(seriesId: string, chapterIds: string[]) {
  const todo = nextChapters(chapterIds, null, chapterIds.length, state);
  enqueueChapters(seriesId, todo);
  return todo.length;
}

/** Auto-download of the next chapters when one is opened (setting, Wi-Fi only). */
export function autoDownloadAfter(chapterId: string) {
  if (!downloadsSupported || !prefs.autoNext || offline() || !onWifi()) return;
  const found = getChapter(chapterId);
  if (!found?.series.manhwa) return;
  const ids = found.series.manhwa.chapters.map((c) => c.id);
  enqueueChapters(found.series.id, nextChapters(ids, chapterId, prefs.autoCount, state));
}

export function pauseDownload(chapterId: string) {
  dispatch({ type: 'pause', chapterId });
  controllers.get(chapterId)?.abort();
}
export const resumeDownload = (chapterId: string) => dispatch({ type: 'resume', chapterId });

export function pauseAll() {
  dispatch({ type: 'pauseAll' });
  controllers.forEach((c) => c.abort());
}
export const resumeAll = () => dispatch({ type: 'resumeAll' });

/** Cancels a download (or deletes a downloaded chapter) and its files. */
export function removeDownload(chapterId: string) {
  controllers.get(chapterId)?.abort();
  controllers.delete(chapterId);
  deleteFiles(chapterId);
  dispatch({ type: 'remove', chapterId });
}
export const cancelDownload = removeDownload;

export function removeSeriesDownloads(seriesId: string) {
  for (const e of Object.values(state)) {
    if (e.seriesId !== seriesId) continue;
    controllers.get(e.chapterId)?.abort();
    controllers.delete(e.chapterId);
    deleteFiles(e.chapterId);
  }
  dispatch({ type: 'removeSeries', seriesId });
}

export function removeAllDownloads() {
  controllers.forEach((c) => c.abort());
  controllers.clear();
  try {
    const root = new Directory(Paths.document, 'chapters');
    if (root.exists) root.delete();
  } catch {
    // ignore
  }
  for (const id of Object.keys(state)) dispatch({ type: 'remove', chapterId: id });
}

export const activeDownloads = () => Object.values(state).filter(isActive).length;

export function formatBytes(n: number) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} Ko`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} Mo`;
  return `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} Go`;
}

/** Short status of a chapter for lists ("Téléchargé", "42 %", "En pause"…). */
export function downloadLabel(e: DownloadEntry | undefined, blocked: QueueBlock): string | undefined {
  if (!e) return undefined;
  switch (e.status) {
    case 'done':
      return 'Téléchargé';
    case 'downloading':
      return e.total ? `${Math.round((e.saved / e.total) * 100)} %` : 'Préparation…';
    case 'queued':
      return blocked === 'wifi-only' ? 'En attente du Wi-Fi' : blocked === 'offline' ? 'En attente du réseau' : 'En file';
    case 'paused':
      return 'En pause';
    case 'error':
      return 'Échec';
  }
}
