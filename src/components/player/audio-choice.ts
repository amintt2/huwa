// The audio track the user picked by hand, remembered per series and per watch mode (VO / VF):
// it carries over to the next episodes, other sources and seeks (see audio-pick.ts).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import type { AudioPick } from './audio-pick';

const KEY = 'huwa/audio-choice/v1';
/** Oldest choices are dropped past this many series. */
const MAX = 200;

type Entry = AudioPick & { at: number };
let choices: Record<string, Entry> = {};
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

AsyncStorage.getItem(KEY)
  .then((raw) => {
    if (!raw) return;
    // A choice made before the read wins over the saved one.
    choices = { ...(JSON.parse(raw) as Record<string, Entry>), ...choices };
    notify();
  })
  .catch(() => {});

const scopeOf = (seriesId: string, mode: string) => `${seriesId}:${mode}`;

export function getAudioChoice(seriesId: string, mode: string): AudioPick | null {
  const e = choices[scopeOf(seriesId, mode)];
  return e ? { lang: e.lang, ...(e.label ? { label: e.label } : null) } : null;
}

export function setAudioChoice(seriesId: string, mode: string, pick: AudioPick | null) {
  const k = scopeOf(seriesId, mode);
  const next = { ...choices };
  if (pick) next[k] = { ...pick, at: Date.now() };
  else delete next[k];
  const keys = Object.keys(next).sort((a, b) => next[b].at - next[a].at);
  choices = Object.fromEntries(keys.slice(0, MAX).map((x) => [x, next[x]]));
  notify();
  AsyncStorage.setItem(KEY, JSON.stringify(choices)).catch(() => {});
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Stable between changes (the entry object), for `useSyncExternalStore`. */
export function useAudioChoice(seriesId: string, mode: string): AudioPick | null {
  const entry = useSyncExternalStore(subscribe, () => choices[scopeOf(seriesId, mode)] ?? null);
  return entry ? { lang: entry.lang, ...(entry.label ? { label: entry.label } : null) } : null;
}
