// Download queue: a pure state machine (reducer + selectors), unit-tested in __tests__/queue.test.ts.
// The runtime (./store.ts, ./host.tsx) feeds it events and starts what `startable` returns.
//
//   queued ─start→ resolving ─resolved→ downloading ─complete→ done
//     ↑  ↖───────────── fail (retryable, attempts left: back off) ─┘ └─fail (final)→ failed
//     └─ resume ── paused ←─ pause (from queued / waiting-network / resolving / downloading)
//   waiting-network ⇄ queued when Wi-Fi only and the device is on cellular / offline.
import type { DlQuality, DlSource, DlKind, DownloadItem, NetworkKind } from './types';

export type Items = Record<string, DownloadItem>;

export const MAX_ATTEMPTS = 4;
/** Backoff before automatic retry n (1-based): 5 s, 30 s, 2 min. */
export const retryDelayMs = (attempt: number) => [5e3, 30e3, 120e3][Math.min(attempt - 1, 2)] ?? 120e3;

export type NewDownload = Pick<DownloadItem, 'id' | 'seriesId' | 'episode' | 'seriesTitle' | 'title' | 'durationMin' | 'image'> & {
  quality: DlQuality;
  wifiOnly: boolean;
  preferredKey?: string;
  /** Source already resolved by the watch screen (used first). */
  source?: DlSource;
  kind?: DlKind;
  auto?: boolean;
  subtitleSources?: DownloadItem['subtitleSources'];
};

export type DlEvent =
  | { type: 'enqueue'; items: NewDownload[]; now: number }
  | { type: 'start'; id: string }
  | { type: 'resolved'; id: string; source: DlSource; kind: DlKind }
  | { type: 'progress'; id: string; bytes: number; total: number }
  | { type: 'pause'; id: string; resume?: string }
  | { type: 'resume'; id: string }
  | { type: 'fail'; id: string; error: string; retryable: boolean; expired?: boolean; now: number }
  | { type: 'complete'; id: string; file: string; bytes: number; now: number }
  | { type: 'remove'; id: string }
  | { type: 'network'; network: NetworkKind }
  | { type: 'patch'; id: string; patch: Partial<DownloadItem> }
  /** App relaunched: nothing is running any more. */
  | { type: 'restore' };

const ACTIVE = new Set(['resolving', 'downloading']);
export const isActive = (i: DownloadItem) => ACTIVE.has(i.status);
export const isPending = (i: DownloadItem) => i.status !== 'done' && i.status !== 'failed';

const set = (s: Items, id: string, p: Partial<DownloadItem>): Items => (s[id] ? { ...s, [id]: { ...s[id], ...p } } : s);

export function reduce(s: Items, e: DlEvent): Items {
  switch (e.type) {
    case 'enqueue': {
      let out = s;
      e.items.forEach((n, i) => {
        const old = out[n.id];
        // Already downloaded or on its way: keep it (a failed one is queued again).
        if (old && old.status !== 'failed') return;
        out = {
          ...out,
          [n.id]: {
            ...n,
            status: 'queued',
            bytes: 0,
            total: 0,
            attempts: 0,
            subtitles: [],
            // Keeps the episode order of a batch.
            createdAt: e.now + i,
          },
        };
      });
      return out;
    }
    case 'start':
      return s[e.id]?.status === 'queued' ? set(s, e.id, { status: s[e.id].source?.url ? 'downloading' : 'resolving', error: undefined }) : s;
    case 'resolved':
      return s[e.id] && isActive(s[e.id]) ? set(s, e.id, { status: 'downloading', source: e.source, kind: e.kind }) : s;
    case 'progress':
      return s[e.id]?.status === 'downloading' ? set(s, e.id, { bytes: e.bytes, total: e.total > 0 ? e.total : s[e.id].total }) : s;
    case 'pause': {
      const i = s[e.id];
      if (!i || i.status === 'done' || i.status === 'failed') return s;
      return set(s, e.id, { status: 'paused', resume: e.resume ?? i.resume });
    }
    case 'resume': {
      const i = s[e.id];
      if (!i || (i.status !== 'paused' && i.status !== 'failed')) return s;
      // Manual action: a fresh set of attempts, and a failed item re-resolves its link.
      return set(s, e.id, {
        status: 'queued',
        attempts: 0,
        retryAt: undefined,
        error: undefined,
        ...(i.status === 'failed' ? { resume: undefined, source: i.source ? { ...i.source, url: undefined } : undefined } : {}),
      });
    }
    case 'fail': {
      const i = s[e.id];
      if (!i || !isActive(i)) return s;
      const attempts = i.attempts + 1;
      // Expired link (debrid / signed URL): forget it, the addons are asked again.
      const source = e.expired && i.source ? { ...i.source, url: undefined } : i.source;
      if (e.retryable && attempts < MAX_ATTEMPTS) {
        return set(s, e.id, { status: 'queued', attempts, error: e.error, retryAt: e.now + retryDelayMs(attempts), source, resume: e.expired ? undefined : i.resume });
      }
      return set(s, e.id, { status: 'failed', attempts, error: e.error, source, resume: undefined });
    }
    case 'complete':
      return s[e.id] ? set(s, e.id, { status: 'done', file: e.file, bytes: e.bytes, total: e.bytes, doneAt: e.now, resume: undefined, error: undefined, retryAt: undefined }) : s;
    case 'remove': {
      if (!s[e.id]) return s;
      const { [e.id]: _gone, ...rest } = s;
      return rest;
    }
    case 'network': {
      let out = s;
      for (const i of Object.values(s)) {
        const blocked = i.wifiOnly && e.network !== 'wifi';
        if (i.status === 'queued' && blocked) out = set(out, i.id, { status: 'waiting-network' });
        else if (i.status === 'waiting-network' && !blocked && e.network !== 'offline') out = set(out, i.id, { status: 'queued' });
      }
      return out;
    }
    case 'patch':
      return set(s, e.id, e.patch);
    case 'restore': {
      let out = s;
      // Interrupted transfers wait for the runner again (resumed from their saved state).
      for (const i of Object.values(s)) if (isActive(i)) out = set(out, i.id, { status: 'queued' });
      return out;
    }
  }
}

/**
 * Items to start now, oldest first: queued, past their backoff, allowed on this network, within
 * the concurrency limit (resolving + downloading count as running).
 */
export function startable(s: Items, opts: { now: number; network: NetworkKind; concurrency: number }): string[] {
  if (opts.network === 'offline') return [];
  const list = Object.values(s);
  const running = list.filter(isActive).length;
  const free = opts.concurrency - running;
  if (free <= 0) return [];
  return list
    .filter((i) => i.status === 'queued' && (i.retryAt ?? 0) <= opts.now && (!i.wifiOnly || opts.network === 'wifi'))
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, free)
    .map((i) => i.id);
}

/** Soonest automatic retry still waiting (ms from now), for the runner's timer. */
export function nextRetryIn(s: Items, now: number): number | null {
  const waits = Object.values(s)
    .filter((i) => i.status === 'queued' && i.retryAt && i.retryAt > now)
    .map((i) => i.retryAt! - now);
  return waits.length ? Math.min(...waits) : null;
}

// ---------- what a menu entry queues ----------

export type EpisodeRef = { id: string; number: number };

/**
 * Episodes for "Télécharger" (one), "Télécharger les N suivants" (from this one, N episodes)
 * and "Télécharger la saison" (every episode). Episodes already downloaded or queued are skipped.
 */
export function planEpisodes(episodes: EpisodeRef[], from: number, mode: 'one' | 'next' | 'season', items: Items, n = 3): string[] {
  const sorted = [...episodes].sort((a, b) => a.number - b.number);
  const pick =
    mode === 'season'
      ? sorted
      : mode === 'one'
        ? sorted.filter((e) => e.number === from)
        : sorted.filter((e) => e.number >= from).slice(0, n);
  return pick.filter((e) => !items[e.id] || items[e.id].status === 'failed').map((e) => e.id);
}

// ---------- storage ----------

export const doneBytes = (s: Items) => Object.values(s).reduce((n, i) => n + (i.status === 'done' ? i.bytes : i.bytes || 0), 0);

/**
 * Room for `incoming` bytes under `quota`: watched downloads go first (oldest first), never one
 * that is not watched. `fits` = false when even that is not enough.
 */
export function evictionsFor(s: Items, quota: number, incoming: number, watched: (id: string) => boolean): { evict: string[]; fits: boolean } {
  let used = doneBytes(s);
  const evict: string[] = [];
  if (used + incoming <= quota) return { evict, fits: true };
  const old = Object.values(s)
    .filter((i) => i.status === 'done' && watched(i.id))
    .sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0));
  for (const i of old) {
    if (used + incoming <= quota) break;
    evict.push(i.id);
    used -= i.bytes;
  }
  return { evict, fits: used + incoming <= quota };
}

/** "Supprimer les épisodes vus": downloads of episodes watched to the end. */
export const watchedDownloads = (s: Items, watched: (id: string) => boolean) =>
  Object.values(s).filter((i) => i.status === 'done' && watched(i.id)).map((i) => i.id);

/**
 * "Épisode suivant automatiquement sur Wi-Fi": for each series in progress (last episode watched
 * or downloaded), the episode right after the last one watched, when it exists and isn't
 * downloaded or queued yet.
 */
export function autoNextEpisodes(
  series: { seriesId: string; episodes: EpisodeRef[]; lastWatched: number | null }[],
  s: Items,
): { seriesId: string; id: string }[] {
  const out: { seriesId: string; id: string }[] = [];
  for (const x of series) {
    if (x.lastWatched == null) continue;
    const next = x.episodes.find((e) => e.number === x.lastWatched! + 1);
    if (next && !s[next.id]) out.push({ seriesId: x.seriesId, id: next.id });
  }
  return out;
}

/** Downloads grouped by series (most recent activity first), episodes in order. */
export function groupBySeries(s: Items) {
  const map = new Map<string, DownloadItem[]>();
  for (const i of Object.values(s)) map.set(i.seriesId, [...(map.get(i.seriesId) ?? []), i]);
  return [...map.entries()]
    .map(([seriesId, items]) => ({
      seriesId,
      title: items[0].seriesTitle,
      image: items[0].image,
      items: items.sort((a, b) => a.episode - b.episode),
      bytes: items.reduce((n, i) => n + i.bytes, 0),
      latest: Math.max(...items.map((i) => i.doneAt ?? i.createdAt)),
    }))
    .sort((a, b) => b.latest - a.latest);
}
