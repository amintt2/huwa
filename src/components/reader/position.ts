// Exact reading position (page index + offset inside that page) and reader preferences.
// The shared store keeps the coarse chapter ratio used across the app; this adds precision.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { registerRehydrate } from '@/settings/rehydrate';

export type ReadPosition = { page: number; /** 0‒1 inside the page */ offset: number };
export type ReaderMode = 'vertical' | 'paged';

/** Width / height of each page, by index: resuming a webtoon needs the real page heights. */
type Saved = { positions: Record<string, ReadPosition>; mode: ReaderMode; aspects?: Record<string, number[]> };

const MAX_ASPECTS = 60;

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

registerRehydrate(async () => {
  clearTimeout(timer);
  const raw = await AsyncStorage.getItem(KEY).catch(() => null);
  try {
    saved = { positions: {}, mode: 'vertical', ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    saved = { positions: {}, mode: 'vertical' };
  }
  listeners.forEach((l) => l());
});

function persist() {
  listeners.forEach((l) => l());
  clearTimeout(timer);
  timer = setTimeout(() => AsyncStorage.setItem(KEY, JSON.stringify(saved)).catch(() => {}), 500);
}

export const isReaderHydrated = () => hydrated;
/** Old vertical / paged switch (now part of the reader settings). */
export const getReaderMode = () => saved.mode;
export const getPosition = (chapterId: string): ReadPosition | undefined => saved.positions[chapterId];

export function savePosition(chapterId: string, pos: ReadPosition) {
  const prev = saved.positions[chapterId];
  if (prev && prev.page === pos.page && Math.abs(prev.offset - pos.offset) < 0.02) return;
  saved = { ...saved, positions: { ...saved.positions, [chapterId]: pos } };
  persist();
}

export const getAspects = (chapterId: string): number[] | undefined => saved.aspects?.[chapterId];

export function saveAspects(chapterId: string, aspects: number[]) {
  const prev = saved.aspects?.[chapterId];
  if (prev && prev.length === aspects.length && prev.every((a, i) => Math.abs(a - (aspects[i] ?? 0)) < 0.005)) return;
  const { [chapterId]: _old, ...rest } = saved.aspects ?? {};
  const keys = Object.keys(rest);
  // Most recent last; drop the oldest chapters beyond the cap.
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASPECTS + 1))) delete rest[k];
  saved = { ...saved, aspects: { ...rest, [chapterId]: aspects.map((a) => Math.round(a * 1000) / 1000) } };
  persist();
}

