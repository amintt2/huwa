// UI-side social preferences (not part of the P2P contract): who I follow, which block
// lists I subscribe to, muted words, DM notification mode, local nicknames. The contract
// exposes the write paths (follow, subscribeLabeler…) but no getters, so the UI keeps its
// own persisted mirror; the P2P layer stays the source for what peers see.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

export type DmNotifMode = 'discreet' | 'instant';

export type Prefs = {
  follows: string[];
  subscriptions: string[];
  /** Hidden (unsubscribed) lists that stay listed in the moderation screen. */
  knownLabelers: string[];
  words: string[];
  dmNotif: DmNotifMode;
  /** Accept message requests from people I do not follow. */
  dmRequests: boolean;
  petnames: Record<string, string>;
  /** Default block lists were subscribed once (after identity creation). */
  defaultsApplied: boolean;
};

const KEY = 'huwa/prefs/v1';
const initial: Prefs = {
  follows: [],
  subscriptions: [],
  knownLabelers: [],
  words: [],
  dmNotif: 'discreet',
  dmRequests: true,
  petnames: {},
  defaultsApplied: false,
};

let prefs: Prefs = initial;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

export const prefsReady = AsyncStorage.getItem(KEY)
  .then((raw) => {
    if (raw) prefs = { ...initial, ...JSON.parse(raw) };
  })
  .catch(() => {})
  .finally(() => listeners.forEach((l) => l()));

export function setPrefs(update: (p: Prefs) => Prefs) {
  prefs = update(prefs);
  listeners.forEach((l) => l());
  clearTimeout(timer);
  timer = setTimeout(() => AsyncStorage.setItem(KEY, JSON.stringify(prefs)).catch(() => {}), 250);
}

export const getPrefs = () => prefs;

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Selectors must return stable references (slices or primitives). */
export function usePrefs<T>(selector: (p: Prefs) => T): T {
  return useSyncExternalStore(subscribe, () => selector(prefs), () => selector(prefs));
}

export const toggleIn = (list: string[], v: string, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
