// Tiny persisted store (useSyncExternalStore + AsyncStorage) for progress and "my list".
// Comments, likes and the user name moved to the P2P layer (src/p2p): the legacy
// `comments`/`liked`/`userName` fields are kept read-only so `migrateLegacy` can import them.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { getSeries } from '@/data/catalog';

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
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function set(updater: (s: State) => State) {
  state = updater(state);
  listeners.forEach((l) => l());
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    AsyncStorage.setItem(KEY, JSON.stringify(state)).catch(() => {});
  }, 400);
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
  clearTimeout(saveTimer);
  try {
    const raw = await AsyncStorage.getItem(KEY);
    state = raw ? { ...initial, ...JSON.parse(raw) } : { ...initial };
  } catch {
    state = { ...initial };
  }
  listeners.forEach((l) => l());
}
