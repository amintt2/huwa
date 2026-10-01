// "Moteur de lecture" setting (Automatique / Natif / mpv) and the engine currently in use,
// kept apart from the player prefs so the engine layer stays self-contained.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { demoEngine } from '@/demo/flags';

import type { Engine, EnginePref } from './policy';
import { registerRehydrate } from '@/settings/rehydrate';

const KEY = 'huwa/player-engine/v1';

let pref: EnginePref = demoEngine ?? 'auto';
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const load = () =>
  AsyncStorage.getItem(KEY)
    .then((raw) => {
      if (!demoEngine && (raw === 'auto' || raw === 'native' || raw === 'mpv' || raw === null)) {
        pref = raw ?? 'auto';
        emit();
      }
    })
    .catch(() => {});
load();
registerRehydrate(load);

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
