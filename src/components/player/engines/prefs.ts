// "Moteur de lecture" setting (Automatique / Natif / mpv) and the engine currently in use,
// kept apart from the player prefs so the engine layer stays self-contained.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import type { Engine, EnginePref } from './policy';

const KEY = 'huwa/player-engine/v1';

let pref: EnginePref = 'auto';
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

AsyncStorage.getItem(KEY)
  .then((raw) => {
    if (raw === 'auto' || raw === 'native' || raw === 'mpv') {
      pref = raw;
      emit();
    }
  })
  .catch(() => {});

export const getEnginePref = () => pref;

export function setEnginePref(next: EnginePref) {
  pref = next;
  emit();
  AsyncStorage.setItem(KEY, next).catch(() => {});
}

export const useEnginePref = () => useSyncExternalStore(subscribe, getEnginePref, getEnginePref);

// ---- engine of the player on screen (for the "mpv" badge in the sources menu) ----

export type ActiveEngine = { engine: Engine; reason: string; detail: string } | null;

let active: ActiveEngine = null;
const activeListeners = new Set<() => void>();
const subscribeActive = (l: () => void) => {
  activeListeners.add(l);
  return () => activeListeners.delete(l);
};
const getActive = () => active;

export function setActiveEngine(next: ActiveEngine) {
  if (next?.engine === active?.engine && next?.reason === active?.reason && next?.detail === active?.detail) return;
  active = next;
  activeListeners.forEach((l) => l());
}

export const useActiveEngine = () => useSyncExternalStore(subscribeActive, getActive, getActive);
