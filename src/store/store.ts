// Tiny persisted store (useSyncExternalStore + AsyncStorage).
// Swap the persistence layer for a backend (Supabase, Firebase…) to share
// comments between users; the actions below are the only write paths.
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

export function setUserName(userName: string) {
  set((s) => ({ ...s, userName: userName.trim() || 'moi' }));
}

export function addComment(c: Omit<Comment, 'id' | 'createdAt' | 'likes' | 'author' | 'fromAnime'>) {
  set((s) => {
    const seriesId = seriesIdOfTarget(c.target);
    const fromAnime =
      c.target.startsWith('ch:') && Object.keys(s.episodes).some((k) => k.startsWith(seriesId + '-e'));
    const comment: Comment = {
      ...c,
      id: `u-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      createdAt: Date.now(),
      likes: 0,
      author: s.userName,
      fromAnime,
    };
    return { ...s, comments: [comment, ...s.comments] };
  });
}

export function toggleLike(commentId: string) {
  set((s) => {
    const liked = { ...s.liked };
    if (liked[commentId]) delete liked[commentId];
    else liked[commentId] = true;
    return { ...s, liked };
  });
}

export function resetAll() {
  set(() => ({ ...initial, comments: [], liked: {} }));
}

export function seriesIdOfTarget(target: string) {
  const id = target.split(':')[1] ?? '';
  return id.split('-')[0];
}

export const seriesTitleOfTarget = (target: string) => getSeries(seriesIdOfTarget(target))?.title ?? '';
