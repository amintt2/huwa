// Tiny persisted store (useSyncExternalStore + AsyncStorage) for progress and "my list".
// Comments, likes and the user name moved to the P2P layer (src/p2p): the legacy
// `comments`/`liked`/`userName` fields are kept read-only so `migrateLegacy` can import them.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { getSeries } from '@/data/catalog';

import { debouncedWriter } from './persist';

export type EpisodeProgress = { position: number; duration: number; done: boolean; updatedAt: number };
export type ChapterProgress = { ratio: number; done: boolean; updatedAt: number };

export type Comment = {
  id: string;
  /** `ep:<episodeId>`, `ch:<chapterId>` or `series:<seriesId>` */
  target: string;
  parentId?: string;
  author: string;
  text: string;
  createdAt: number;
  likes: number;
  spoiler: boolean;
  /** Seconds into the episode, for time-anchored anime comments. */
  timestamp?: number;
  /** Author came to the manhwa from the anime. */
  fromAnime?: boolean;
};

export type State = {
  userName: string;
  episodes: Record<string, EpisodeProgress>;
  chapters: Record<string, ChapterProgress>;
  myList: string[];
  comments: Comment[];
  liked: Record<string, true>;
};

const KEY = 'huwa/state/v1';

const initial: State = {
  userName: 'moi',
  episodes: {},
  chapters: {},
  myList: [],
  comments: [],
  liked: {},
};

let state: State = initial;
let hydrated = false;
const listeners = new Set<() => void>();
// Flushed on backgrounding and when the player closes (see persist.ts).
const saver = debouncedWriter(() => AsyncStorage.setItem(KEY, JSON.stringify(state)), 400);

function set(updater: (s: State) => State) {
  state = updater(state);
  listeners.forEach((l) => l());
  saver.schedule();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Select a slice. Selectors must return stable references (state slices or primitives). */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

export const getState = () => state;

export function useHydrated() {
  const [ready, setReady] = useState(hydrated);
  useEffect(() => {
    if (hydrated) return;
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (raw) state = { ...initial, ...JSON.parse(raw) };
      })
      .catch(() => {})
      .finally(() => {
        hydrated = true;
        setReady(true);
        listeners.forEach((l) => l());
      });
  }, []);
  return ready;
}

// ---------- actions ----------

export function saveEpisodeProgress(id: string, position: number, duration: number) {
  if (!duration || !isFinite(duration)) return;
  const done = position / duration > 0.92;
  set((s) => ({
    ...s,
    episodes: {
      ...s.episodes,
      [id]: { position, duration, done: done || !!s.episodes[id]?.done, updatedAt: Date.now() },
    },
  }));
}

export function markEpisodeDone(id: string) {
  set((s) => {
    const prev = s.episodes[id];
    const duration = prev?.duration ?? 1;
    return {
      ...s,
      episodes: { ...s.episodes, [id]: { position: duration, duration, done: true, updatedAt: Date.now() } },
    };
  });
}

export function saveChapterProgress(id: string, ratio: number) {
  set((s) => {
    const prev = s.chapters[id];
    const r = Math.max(prev?.done ? 1 : 0, Math.min(1, ratio));
    return {
      ...s,
      chapters: { ...s.chapters, [id]: { ratio: r, done: r > 0.95 || !!prev?.done, updatedAt: Date.now() } },
    };
  });
}

export function toggleMyList(seriesId: string) {
  set((s) => ({
    ...s,
    myList: s.myList.includes(seriesId) ? s.myList.filter((x) => x !== seriesId) : [seriesId, ...s.myList],
  }));
}

/** Progress removed by `removeFromHistory`, for "Annuler". */
export type HistorySnapshot = { episodes: State['episodes']; chapters: State['chapters'] };

/**
 * Removes a series from "En cours" (its episode or chapter progress) and returns what was removed
 * so it can be put back. The rank journal (XP) is not touched.
 */
export function removeFromHistory(seriesId: string, kind: 'anime' | 'manhwa'): HistorySnapshot {
  const series = getSeries(seriesId);
  const ids = new Set(kind === 'anime' ? (series?.anime?.episodes ?? []).map((e) => e.id) : (series?.manhwa?.chapters ?? []).map((c) => c.id));
  const removed: HistorySnapshot = { episodes: {}, chapters: {} };
  set((s) => {
    const pick = <T,>(rec: Record<string, T>, out: Record<string, T>) => {
      const keep: Record<string, T> = {};
      for (const [id, v] of Object.entries(rec)) {
        if (ids.has(id)) out[id] = v;
        else keep[id] = v;
      }
      return keep;
    };
    return kind === 'anime' ? { ...s, episodes: pick(s.episodes, removed.episodes) } : { ...s, chapters: pick(s.chapters, removed.chapters) };
  });
  return removed;
}

export function restoreHistory(snap: HistorySnapshot) {
  set((s) => ({ ...s, episodes: { ...s.episodes, ...snap.episodes }, chapters: { ...s.chapters, ...snap.chapters } }));
}

export function resetAll() {
  set(() => ({ ...initial, comments: [], liked: {} }));
}

export function seriesIdOfTarget(target: string) {
  const id = target.split(':')[1] ?? '';
  return id.split('-')[0];
}

export const seriesTitleOfTarget = (target: string) => getSeries(seriesIdOfTarget(target))?.title ?? '';

/** Re-read the persisted state, e.g. after importing a backup (Réglages → Importer). */
export async function rehydrateStore() {
  saver.cancel();
  try {
    const raw = await AsyncStorage.getItem(KEY);
    state = raw ? { ...initial, ...JSON.parse(raw) } : { ...initial };
  } catch {
    state = { ...initial };
  }
  listeners.forEach((l) => l());
}
