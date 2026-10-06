// Persisted reader settings (Global / Source / Titre), see `settings.ts` for the resolution.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { registerRehydrate } from '@/settings/rehydrate';

import { getReaderMode, readerReady } from './position';
import {
  EMPTY_STATE,
  resolveSettings,
  sanitizeState,
  setAt,
  setSync,
  activeScope,
  type ReaderSettings,
  type Scope,
  type ScopeKeys,
  type SettingsState,
} from './settings';

const KEY = 'huwa/reader/settings/v1';
let state: SettingsState = EMPTY_STATE;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

const emit = () => listeners.forEach((l) => l());

async function load() {
  const raw = await AsyncStorage.getItem(KEY).catch(() => null);
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed) state = sanitizeState(parsed);
  else {
    // First run: carry over the old vertical / paged switch.
    await readerReady;
    state = getReaderMode() === 'paged' ? setAt(EMPTY_STATE, 'global', {}, { type: 'paged' }) : EMPTY_STATE;
  }
  emit();
}

export const settingsReady = load();

registerRehydrate(async () => {
  clearTimeout(timer);
  state = EMPTY_STATE;
  await load();
});

function commit(next: SettingsState) {
  if (next === state) return;
  state = next;
  emit();
  clearTimeout(timer);
  timer = setTimeout(() => AsyncStorage.setItem(KEY, JSON.stringify(state)).catch(() => {}), 400);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const useSettingsState = () => useSyncExternalStore(subscribe, () => state, () => state);

/** Effective settings for a series read from a source. */
export function useReaderSettings(keys: ScopeKeys): ReaderSettings {
  const s = useSettingsState();
  return resolveSettings(s, keys);
}

export const setReaderSetting = (scope: Scope, keys: ScopeKeys, patch: Partial<ReaderSettings>) => commit(setAt(state, scope, keys, patch));
export const setScopeSync = (scope: Exclude<Scope, 'global'>, keys: ScopeKeys, sync: boolean) => commit(setSync(state, scope, keys, sync));
/** Quick toggles from the reader write where the effective value comes from. */
export const setActiveSetting = (keys: ScopeKeys, patch: Partial<ReaderSettings>) => commit(setAt(state, activeScope(state, keys), keys, patch));
