// Exact reading position (page index + offset inside that page) and reader preferences.
// The shared store keeps the coarse chapter ratio used across the app; this adds precision.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

export type ReadPosition = { page: number; /** 0‒1 inside the page */ offset: number };
export type ReaderMode = 'vertical' | 'paged';

type Saved = { positions: Record<string, ReadPosition>; mode: ReaderMode };

const KEY = 'huwa/reader/v1';
let saved: Saved = { positions: {}, mode: 'vertical' };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let hydrated = false;

export const readerReady = AsyncStorage.getItem(KEY)
  .then((raw) => {
    if (raw) saved = { ...saved, ...JSON.parse(raw) };
  })
  .catch(() => {})
  .finally(() => {
    hydrated = true;
    listeners.forEach((l) => l());
  });

function persist() {
  listeners.forEach((l) => l());
  clearTimeout(timer);
  timer = setTimeout(() => AsyncStorage.setItem(KEY, JSON.stringify(saved)).catch(() => {}), 500);
}

export const isReaderHydrated = () => hydrated;
export const getPosition = (chapterId: string): ReadPosition | undefined => saved.positions[chapterId];

export function savePosition(chapterId: string, pos: ReadPosition) {
  const prev = saved.positions[chapterId];
  if (prev && prev.page === pos.page && Math.abs(prev.offset - pos.offset) < 0.02) return;
  saved = { ...saved, positions: { ...saved.positions, [chapterId]: pos } };
  persist();
}

export function setReaderMode(mode: ReaderMode) {
  saved = { ...saved, mode };
  persist();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const useReaderMode = () => useSyncExternalStore(subscribe, () => saved.mode, () => saved.mode);
