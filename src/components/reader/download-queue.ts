// Chapter download queue as a pure state machine (no I/O), driven by `downloads.ts`:
//
//   queued ──start──▶ downloading ──done──▶ done
//     ▲  ╲                │   ╲
//     │   pause         fail  pause
//     │     ╲             ▼     ╲
//     └resume── paused ◀──────── error ──resume──▶ queued
//
// `remove` drops an entry from any state (the caller deletes the files). Order of the queue is
// the order of `enqueue` (a chapter enqueued again keeps its place).

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'done' | 'error';

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
  /** Position in the queue (lower starts first). */
  order: number;
  error?: string;
};

export type Downloads = Record<string, DownloadEntry>;

export type QueueEvent =
  | { type: 'enqueue'; chapterId: string; seriesId: string; at: number }
  | { type: 'start'; chapterId: string }
  | { type: 'pages'; chapterId: string; files: string[] }
  | { type: 'progress'; chapterId: string; saved: number }
  | { type: 'done'; chapterId: string; bytes: number }
  | { type: 'fail'; chapterId: string; error: string }
  | { type: 'pause'; chapterId: string }
  | { type: 'resume'; chapterId: string }
  | { type: 'pauseAll' }
  | { type: 'resumeAll' }
  | { type: 'remove'; chapterId: string }
  | { type: 'removeSeries'; seriesId: string }
  /** Saved state after an app restart: interrupted downloads go back to the queue. */
  | { type: 'restore'; saved: Downloads };

const ACTIVE: DownloadStatus[] = ['queued', 'downloading'];
export const isActive = (e?: Pick<DownloadEntry, 'status'>) => !!e && ACTIVE.includes(e.status);

function put(s: Downloads, id: string, p: Partial<DownloadEntry>): Downloads {
  const cur = s[id];
  return cur ? { ...s, [id]: { ...cur, ...p } } : s;
}

const nextOrder = (s: Downloads) => Object.values(s).reduce((m, e) => Math.max(m, e.order ?? 0), 0) + 1;

export function reduce(s: Downloads, ev: QueueEvent): Downloads {
  switch (ev.type) {
    case 'enqueue': {
      const cur = s[ev.chapterId];
      if (cur && cur.status !== 'error' && cur.status !== 'paused') return s;
      if (cur) return put(s, ev.chapterId, { status: 'queued', error: undefined });
      return {
        ...s,
        [ev.chapterId]: { chapterId: ev.chapterId, seriesId: ev.seriesId, status: 'queued', files: [], total: 0, saved: 0, bytes: 0, createdAt: ev.at, order: nextOrder(s) },
      };
    }
    case 'start':
      return s[ev.chapterId]?.status === 'queued' ? put(s, ev.chapterId, { status: 'downloading', error: undefined }) : s;
    case 'pages':
      return s[ev.chapterId]?.status === 'downloading' ? put(s, ev.chapterId, { files: ev.files, total: ev.files.length }) : s;
    case 'progress':
      return s[ev.chapterId]?.status === 'downloading' ? put(s, ev.chapterId, { saved: Math.min(ev.saved, s[ev.chapterId].total || ev.saved) }) : s;
    case 'done':
      return s[ev.chapterId]?.status === 'downloading' ? put(s, ev.chapterId, { status: 'done', saved: s[ev.chapterId].total, bytes: ev.bytes, error: undefined }) : s;
    case 'fail':
      return s[ev.chapterId]?.status === 'downloading' ? put(s, ev.chapterId, { status: 'error', error: ev.error }) : s;
    case 'pause':
      return isActive(s[ev.chapterId]) ? put(s, ev.chapterId, { status: 'paused' }) : s;
    case 'resume': {
      const st = s[ev.chapterId]?.status;
      return st === 'paused' || st === 'error' ? put(s, ev.chapterId, { status: 'queued', error: undefined }) : s;
    }
    case 'pauseAll': {
      let out = s;
      for (const e of Object.values(s)) if (isActive(e)) out = put(out, e.chapterId, { status: 'paused' });
      return out;
    }
    case 'resumeAll': {
      let out = s;
      for (const e of Object.values(s)) if (e.status === 'paused') out = put(out, e.chapterId, { status: 'queued' });
      return out;
    }
    case 'remove': {
      if (!s[ev.chapterId]) return s;
      const { [ev.chapterId]: _gone, ...rest } = s;
      return rest;
    }
    case 'removeSeries':
      return Object.fromEntries(Object.entries(s).filter(([, e]) => e.seriesId !== ev.seriesId));
    case 'restore': {
      const out: Downloads = { ...s };
      let order = 0;
      for (const e of Object.values(ev.saved)) {
        if (!e || typeof e.chapterId !== 'string' || out[e.chapterId]) continue;
        order++;
        out[e.chapterId] = { ...e, order: e.order ?? order, status: e.status === 'downloading' ? 'queued' : e.status };
      }
      return out;
    }
  }
}

/** Chapters to start now: queued ones in queue order, up to the free slots. */
export function nextToStart(s: Downloads, opts: { concurrency: number; allowed: boolean }): string[] {
  if (!opts.allowed) return [];
  const running = Object.values(s).filter((e) => e.status === 'downloading').length;
  const free = Math.max(0, opts.concurrency - running);
  return Object.values(s)
    .filter((e) => e.status === 'queued')
    .sort((a, b) => a.order - b.order)
    .slice(0, free)
    .map((e) => e.chapterId);
}

export type SeriesDownloads = { seriesId: string; chapters: DownloadEntry[]; done: number; active: number; paused: number; failed: number; bytes: number; updatedAt: number };

/** One row per series: chapters (queue order), counts and storage. Most recent series first. */
export function bySeries(s: Downloads): SeriesDownloads[] {
  const map = new Map<string, SeriesDownloads>();
  for (const e of Object.values(s)) {
    let g = map.get(e.seriesId);
    if (!g) {
      g = { seriesId: e.seriesId, chapters: [], done: 0, active: 0, paused: 0, failed: 0, bytes: 0, updatedAt: 0 };
      map.set(e.seriesId, g);
    }
    g.chapters.push(e);
    g.bytes += e.bytes || 0;
    g.updatedAt = Math.max(g.updatedAt, e.createdAt);
    if (e.status === 'done') g.done++;
    else if (isActive(e)) g.active++;
    else if (e.status === 'paused') g.paused++;
    else g.failed++;
  }
  for (const g of map.values()) g.chapters.sort((a, b) => a.order - b.order);
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Chapters to fetch after `fromId` for "the next N" (auto-download, "Télécharger les N
 * suivants"): the following ones in list order that aren't downloaded or queued yet.
 */
export function nextChapters(chapterIds: string[], fromId: string | null, count: number, s: Downloads, opts: { includeFrom?: boolean } = {}): string[] {
  const at = fromId ? chapterIds.indexOf(fromId) : -1;
  const start = fromId && at < 0 ? chapterIds.length : opts.includeFrom ? Math.max(0, at) : at + 1;
  const out: string[] = [];
  for (let i = start; i < chapterIds.length && out.length < count; i++) {
    const e = s[chapterIds[i]];
    if (!e || e.status === 'error' || e.status === 'paused') out.push(chapterIds[i]);
  }
  return out;
}
