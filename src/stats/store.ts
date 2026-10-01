// On-device playback statistics: a bounded ring of start events + per-addon response times,
// persisted in AsyncStorage. Nothing leaves the device from here (see ./share.ts for the opt-in
// community comparison).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { pushRing, type AddonStat, type PlaybackEvent } from './model';

const KEY = 'huwa/stats/v1';
export const MAX_EVENTS = 500;
const MAX_ADDON_SAMPLES = 50;
const MAX_ADDONS = 60;

export type StatsState = {
  events: PlaybackEvent[];
  addons: Record<string, AddonStat>;
  /** "Comparer avec la communauté" (opt-in). */
  community: boolean;
  /** Last contribution sent (ms), at most one per week. */
  lastShared: number;
};

const initial: StatsState = { events: [], addons: {}, community: false, lastShared: 0 };
let state: StatsState = initial;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let hydrated = false;

export const statsReady: Promise<void> = AsyncStorage.getItem(KEY)
  .then((raw) => {
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<StatsState>;
    // Events recorded before hydration (very early start) are kept after the saved ones.
    state = {
      ...initial,
      ...saved,
      events: [...(Array.isArray(saved.events) ? saved.events : []), ...state.events].slice(-MAX_EVENTS),
      addons: { ...(saved.addons ?? {}), ...state.addons },
    };
  })
  .catch(() => {})
  .finally(() => {
    hydrated = true;
    listeners.forEach((l) => l());
  });

function set(next: StatsState) {
  state = next;
  listeners.forEach((l) => l());
  if (!hydrated) return;
  clearTimeout(timer);
  timer = setTimeout(() => AsyncStorage.setItem(KEY, JSON.stringify(state)).catch(() => {}), 1000);
}

export const getStats = () => state;

export function recordPlayback(e: PlaybackEvent) {
  set({ ...state, events: pushRing(state.events, e, MAX_EVENTS) });
}

/** One answer (or failure) of a stream addon, keyed by its manifest id. */
export function recordAddon(id: string, name: string, ms: number, ok: boolean) {
  if (!id) return;
  const prev = state.addons[id] ?? { name, ok: 0, fail: 0, ms: [] };
  const next: AddonStat = {
    name,
    ok: prev.ok + (ok ? 1 : 0),
    fail: prev.fail + (ok ? 0 : 1),
    ms: ok ? pushRing(prev.ms, Math.round(ms), MAX_ADDON_SAMPLES) : prev.ms,
  };
  let addons = { ...state.addons, [id]: next };
  const ids = Object.keys(addons);
  if (ids.length > MAX_ADDONS) {
    // Least used addons go first (uninstalled long ago).
    const drop = ids.sort((a, b) => addons[a].ok + addons[a].fail - (addons[b].ok + addons[b].fail))[0];
    addons = Object.fromEntries(Object.entries(addons).filter(([k]) => k !== drop));
  }
  set({ ...state, addons });
}

export function resetStats() {
  set({ ...state, events: [], addons: {} });
}

export function setCommunity(on: boolean) {
  set({ ...state, community: on });
}

export function markShared(at: number) {
  set({ ...state, lastShared: at });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Selectors must return stable references (slices or primitives). */
export function useStats<T>(selector: (s: StatsState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}
