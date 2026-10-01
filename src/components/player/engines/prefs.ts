// "Moteur de lecture" setting (Automatique / Natif / mpv) and the engine currently in use,
// kept apart from the player prefs so the engine layer stays self-contained.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { demoEngine } from '@/demo/flags';

import type { Engine, EnginePref } from './policy';

const KEY = 'huwa/player-engine/v1';

let pref: EnginePref = demoEngine ?? 'auto';
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

// Chosen before the saved value was read: the user's choice wins over the late load.
let touched = false;

AsyncStorage.getItem(KEY)
  .then((raw) => {
    if (!touched && !demoEngine && (raw === 'auto' || raw === 'native' || raw === 'mpv')) {
      pref = raw;
      emit();
    }
  })
  .catch(() => {});

export const getEnginePref = () => pref;

export function setEnginePref(next: EnginePref) {
  touched = true;
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

// One entry per mounted player (a watch screen can stay mounted under another one): the badge
// follows the most recently updated player still alive.
const owners = new Map<object, NonNullable<ActiveEngine>>();

export function setActiveEngine(owner: object, next: ActiveEngine) {
  owners.delete(owner);
  if (next) owners.set(owner, next);
  const last = [...owners.values()].pop() ?? null;
  if (last?.engine === active?.engine && last?.reason === active?.reason && last?.detail === active?.detail) return;
  active = last;
  activeListeners.forEach((l) => l());
}

export const useActiveEngine = () => useSyncExternalStore(subscribeActive, getActive, getActive);
