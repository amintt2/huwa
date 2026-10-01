// Executes what the queue decided: one transfer per item in 'downloading' (HTTP file through
// expo-file-system's DownloadTask, HLS through the native module), then the finishing steps
// (subtitles, meta.json, media probe) and, later, the "compression intelligente" pass.
//
// Background: DownloadTask uses an iOS background URLSession by default, so a transfer keeps
// going while the app is suspended; the JS task object does not survive a kill, so its paused
// state (`savable()`) is saved on pause, and an interrupted transfer starts again on relaunch
// (resumed from the saved state when there is one). The on-device torrent engine serves files on
// 127.0.0.1 inside the app: those transfers use a foreground session (the app must stay open).
import { Directory, DownloadTask, File } from 'expo-file-system';

import { sniff } from '@/components/player/engines/policy';
import { getSeries } from '@/data/catalog';
import { getState as getWatchState } from '@/store/store';

import { HuwaHls } from '../../modules/huwa-hls';
import { HuwaTranscode } from '../../modules/huwa-transcode';
import { canCompressNow, decideCompression, powerReason, verifyOutput } from './compress';
import { isExpiredError, subtitleExt } from './pick';
import { evictionsFor } from './queue';
import {
  deleteEpisodeFiles,
  dispatch,
  ensureEpisodeDir,
  episodeDir,
  formatBytes,
  freeSpace,
  getDlSettings,
  getItem,
  getItems,
  localMediaUri,
  pathIn,
} from './store';
import type { DlQuality, DownloadItem } from './types';

const tasks = new Map<string, DownloadTask>();
/** Transfers this runtime is driving (file or HLS). */
const running = new Set<string>();
/** Stopped on purpose (pause / delete): their rejection is not a failure. */
const stopping = new Set<string>();

export const isRunning = (id: string) => running.has(id);
const now = () => Date.now();
const isLoopback = (u: string) => /^https?:\/\/(127\.|localhost[:/]|\[::1\])/i.test(u);
const pathOf = (uri: string) => decodeURI(uri.replace(/^file:\/\//, ''));
const watched = (id: string) => !!getWatchState().episodes[id]?.done;

// ---------- HLS ----------

const HLS_MIN_BITRATE: Record<Exclude<DlQuality, 'auto'>, number> = { 1080: 4_500_000, 720: 2_000_000, 480: 900_000 };
export const hlsAvailable = () => {
  try {
    return !!HuwaHls?.isAvailable();
  } catch {
    return false;
  }
};

let hlsAttached = false;
/** Native HLS events → queue (once per runtime). Tasks still running natively are adopted. */
export function attachHls() {
  if (hlsAttached || !HuwaHls) return;
  hlsAttached = true;
  HuwaHls.addListener('onProgress', ({ id, progress }) => {
    const i = getItem(id);
    if (!i) return;
    // Bytes are unknown for HLS: progress is reported on a 0–1000 scale.
    dispatch({ type: 'progress', id, bytes: Math.round(progress * 1000), total: 1000 });
  });
  HuwaHls.addListener('onDone', ({ id, path }) => {
    running.delete(id);
    const i = getItem(id);
    if (!i) return;
    const name = path.split('/').pop() ?? 'video.movpkg';
    let bytes = 0;
    try {
      bytes = new Directory(episodeDir(i), name).size ?? 0;
    } catch {
      // size unknown
    }
    dispatch({ type: 'complete', id, file: name, bytes, now: now() });
    void finalize(id);
  });
  HuwaHls.addListener('onError', ({ id, message }) => {
    running.delete(id);
    if (stopping.delete(id) || message === 'cancelled') return;
    dispatch({ type: 'fail', id, error: message, retryable: true, expired: isExpiredError(undefined, message), now: now() });
  });
  HuwaHls.active()
    .then((list) => list.forEach((t) => running.add(t.id)))
    .catch(() => {});
}

// ---------- transfers ----------

/** Starts (or resumes) the transfer of an item in 'downloading' that is not running yet. */
export function runTransfer(item: DownloadItem) {
  if (running.has(item.id) || !item.source?.url) return;
  running.add(item.id);
  ensureEpisodeDir(item);
  if (item.kind === 'hls') return startHls(item);
  void startFile(item);
}

function startHls(item: DownloadItem) {
  if (!hlsAvailable()) {
    running.delete(item.id);
    dispatch({
      type: 'fail', id: item.id, retryable: false, now: now(),
      error: 'HLS : le téléchargement hors ligne demande un iPhone (pas le simulateur) et la dernière version de l’app.',
    });
    return;
  }
  try {
    HuwaHls!.start(item.id, item.source!.url!, pathOf(pathIn(item, 'video.movpkg').uri), {
      headers: item.source!.headers,
      title: `${item.seriesTitle} — ${item.title}`,
      minBitrate: item.quality === 'auto' ? undefined : HLS_MIN_BITRATE[item.quality],
    });
  } catch (e) {
    running.delete(item.id);
    dispatch({ type: 'fail', id: item.id, error: e instanceof Error ? e.message : String(e), retryable: true, now: now() });
  }
}

/** The first bytes look like an HTML / JSON error page instead of a video. */
function looksLikeErrorPage(f: File): boolean {
  try {
    const h = f.open();
    try {
      const head = h.readBytes(4096);
      if (sniff(head).container !== 'unknown') return false;
      const text = String.fromCharCode(...head.slice(0, 64)).trimStart();
      return text.startsWith('<') || text.startsWith('{');
    } finally {
      h.close();
    }
  } catch {
    return false;
  }
}

async function startFile(item: DownloadItem) {
  const src = item.source!;
  const target = pathIn(item, `video.${src.ext}`);
  let quotaChecked = false;
  let lastEmit = 0;
  const onProgress = ({ bytesWritten, totalBytes }: { bytesWritten: number; totalBytes: number }) => {
    if (!quotaChecked && totalBytes > 0) {
      quotaChecked = true;
      const room = checkRoom(item.id, totalBytes - bytesWritten);
      if (room) {
        stopping.add(item.id);
        tasks.get(item.id)?.cancel();
        dispatch({ type: 'fail', id: item.id, error: room, retryable: false, now: now() });
        return;
      }
    }
    const t = now();
    if (t - lastEmit < 500 && bytesWritten < totalBytes) return;
    lastEmit = t;
    dispatch({ type: 'progress', id: item.id, bytes: bytesWritten, total: totalBytes });
  };
  const options = {
    headers: src.headers,
    // The torrent engine's loopback server lives in the app: no background session for it.
    sessionType: isLoopback(src.url!) ? ('foreground' as const) : ('background' as const),
    onProgress,
  };
  let task: DownloadTask;
  let promise: Promise<File | null>;
  try {
    if (item.resume) {
      task = DownloadTask.fromSavable(JSON.parse(item.resume), options);
      tasks.set(item.id, task);
      promise = task.resumeAsync();
    } else {
      if (target.exists) target.delete();
      task = new DownloadTask(src.url!, target, options);
      tasks.set(item.id, task);
      promise = task.downloadAsync();
    }
  } catch (e) {
    running.delete(item.id);
    dispatch({ type: 'fail', id: item.id, error: e instanceof Error ? e.message : String(e), retryable: true, now: now() });
    return;
  }
  try {
    const file = await promise;
    if (!file) return; // paused: pauseDownload() saved the state
    if (looksLikeErrorPage(file) || file.size < 64 * 1024) {
      file.delete();
      throw Object.assign(new Error('Le lien ne renvoie plus la vidéo (expiré ?)'), { expired: true });
    }
    dispatch({ type: 'complete', id: item.id, file: file.name, bytes: file.size, now: now() });
    void finalize(item.id);
  } catch (e) {
    if (stopping.delete(item.id)) return;
    const message = e instanceof Error ? e.message : String(e);
    // A link resolved through a debrid service / with a resume token may have expired: resolve again.
    const expired = (e as { expired?: boolean }).expired || isExpiredError(undefined, message) || !!src.via || !!item.resume;
    dispatch({ type: 'fail', id: item.id, error: message, retryable: true, expired, now: now() });
  } finally {
    running.delete(item.id);
    tasks.delete(item.id);
  }
}

/** Quota and free space for `incoming` more bytes; watched downloads are evicted if needed. */
function checkRoom(id: string, incoming: number): string | null {
  const s = getDlSettings();
  const others = Object.fromEntries(Object.entries(getItems()).filter(([k]) => k !== id));
  const { evict, fits } = evictionsFor(others, s.quotaBytes, incoming, watched);
  if (!fits) return `Quota de ${formatBytes(s.quotaBytes)} atteint : supprime des épisodes ou augmente le quota.`;
  for (const e of evict) removeDownload(e);
  if (freeSpace() < incoming + 500 * 1024 ** 2) return 'Espace insuffisant sur l’appareil.';
  return null;
}

// ---------- user actions ----------

export async function pauseDownload(id: string) {
  const i = getItem(id);
  if (!i) return;
  const task = tasks.get(id);
  if (task) {
    stopping.add(id);
    try {
      await task.pauseAsync();
      dispatch({ type: 'pause', id, resume: JSON.stringify(task.savable()) });
    } catch {
      dispatch({ type: 'pause', id });
    } finally {
      tasks.delete(id);
      running.delete(id);
      stopping.delete(id);
    }
    return;
  }
  if (i.kind === 'hls' && running.has(id)) HuwaHls?.pause(id);
  running.delete(id);
  dispatch({ type: 'pause', id });
}

export function resumeDownload(id: string) {
  const i = getItem(id);
  if (i?.kind === 'hls' && i.status === 'paused') HuwaHls?.resume(id);
  dispatch({ type: 'resume', id });
}

export function removeDownload(id: string) {
  const i = getItem(id);
  if (!i) return;
  stopping.add(id);
  tasks.get(id)?.cancel();
  if (i.kind === 'hls') HuwaHls?.cancel(id);
  if (compressing === id) HuwaTranscode?.cancel(id);
  tasks.delete(id);
  running.delete(id);
  deleteEpisodeFiles(i);
  dispatch({ type: 'remove', id });
  setTimeout(() => stopping.delete(id), 2000);
}

// ---------- after the video ----------

async function finalize(id: string) {
  const i = getItem(id);
  if (!i) return;
  const dir = ensureEpisodeDir(i);
  // Subtitles chosen at resolve time.
  const subtitles: DownloadItem['subtitles'] = [];
  for (const [n, s] of (i.subtitleSources ?? []).entries()) {
    try {
      const f = new File(dir, `sub-${n + 1}.${subtitleExt(s.url)}`);
      await File.downloadFileAsync(s.url, f, { idempotent: true });
      subtitles.push({ lang: s.lang, file: f.name, label: s.label });
    } catch {
      // a missing subtitle never fails the episode
    }
  }
  // Real duration / size of the video for the compression estimate.
  let media: Partial<DownloadItem> = {};
  const uri = localMediaUri(getItem(id));
  if (uri && HuwaTranscode) {
    try {
      const p = await HuwaTranscode.probe(uri);
      media = { durationSec: p.durationSec || undefined, width: p.width, height: p.height, codec: p.codec };
    } catch {
      // not readable by AVFoundation (MKV…): fine
    }
  }
  const compression = getDlSettings().compression;
  dispatch({
    type: 'patch',
    id,
    patch: { subtitles, ...media, compress: compression !== 'off' && i.kind !== 'hls' ? { state: 'pending' } : undefined },
  });
  writeMeta(id);
}

/** meta.json next to the video: the episode and its series, readable without the network. */
export function writeMeta(id: string) {
  const i = getItem(id);
  if (!i) return;
  try {
    const { resume: _r, ...rest } = i;
    new File(episodeDir(i), 'meta.json').write(JSON.stringify({ format: 1, item: rest, series: getSeries(i.seriesId) ?? null }));
  } catch {
    // best effort
  }
}

// ---------- compression intelligente ----------

let compressing: string | null = null;
export const compressionAvailable = () => !!HuwaTranscode;

export function powerState() {
  try {
    return HuwaTranscode?.powerState() ?? null;
  } catch {
    return null;
  }
}

/** Why compression waits right now, or null when it may run. */
export const compressionBlocked = () => powerReason(powerState());

let progressSub: { remove(): void } | undefined;

/** One pending item at a time; called by the host when the app is active. */
export async function compressNext(): Promise<void> {
  if (compressing || !HuwaTranscode) return;
  const mode = getDlSettings().compression;
  if (mode === 'off') return;
  const item = Object.values(getItems()).find((i) => i.status === 'done' && i.compress?.state === 'pending');
  if (!item) return;
  if (!canCompressNow(powerState())) return;
  const input = localMediaUri(item);
  if (!input || !item.file) {
    dispatch({ type: 'patch', id: item.id, patch: { compress: { state: 'skipped', reason: 'Fichier introuvable.' } } });
    return;
  }
  compressing = item.id;
  const id = item.id;
  try {
    const probe = await HuwaTranscode.probe(input);
    const decision = decideCompression(
      {
        container: item.file.split('.').pop() ?? '',
        codec: probe.codec ?? null,
        width: probe.width ?? 0,
        height: probe.height ?? 0,
        durationSec: probe.durationSec,
        sizeBytes: probe.sizeBytes,
        fps: probe.fps,
      },
      mode,
    );
    if (!decision.compress) {
      dispatch({ type: 'patch', id, patch: { compress: { state: decision.unsupported ? 'unsupported' : 'skipped', reason: decision.reason } } });
      return;
    }
    const ext = item.file.split('.').pop()!;
    const out = pathIn(item, `video.hevc.${ext}`);
    progressSub ??= HuwaTranscode.addListener('onProgress', (e) => {
      const cur = getItem(e.id);
      if (cur?.compress?.state === 'running') dispatch({ type: 'patch', id: e.id, patch: { compress: { ...cur.compress, progress: e.progress } } });
    });
    dispatch({ type: 'patch', id, patch: { compress: { state: 'running', progress: 0, originalBytes: probe.sizeBytes, attempts: item.compress?.attempts } } });
    const result = await HuwaTranscode.transcode(id, input, out.uri, { videoBitrate: decision.videoBps, audioBitrate: decision.audioBps });
    const cur = getItem(id);
    if (!cur) {
      // Deleted while encoding.
      if (out.exists) out.delete();
      return;
    }
    const problem = verifyOutput({ durationSec: probe.durationSec, sizeBytes: probe.sizeBytes }, { durationSec: result.durationSec, sizeBytes: result.sizeBytes });
    if (problem) {
      if (out.exists) out.delete();
      dispatch({ type: 'patch', id, patch: { compress: { state: 'failed', reason: `Résultat rejeté : ${problem}. L’original est gardé.` } } });
      return;
    }
    // Verified: the encoded file replaces the original under the same name.
    const original = new File(episodeDir(item), item.file);
    if (original.exists) original.delete();
    out.move(original);
    dispatch({
      type: 'patch',
      id,
      patch: {
        bytes: result.sizeBytes,
        total: result.sizeBytes,
        codec: result.codec ?? 'hvc1',
        compress: { state: 'done', originalBytes: probe.sizeBytes, reason: `${formatBytes(probe.sizeBytes - result.sizeBytes)} gagnés` },
      },
    });
    writeMeta(id);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const cur = getItem(id);
    if (!cur) return;
    const attempts = (cur.compress?.attempts ?? 0) + 1;
    // Interrupted (background time over, app closed): tried again later, 3 times at most.
    dispatch({
      type: 'patch',
      id,
      patch: { compress: attempts < 3 ? { state: 'pending', attempts } : { state: 'failed', reason: message, attempts } },
    });
  } finally {
    compressing = null;
  }
}
