// Active debrid provider + its API key. The key lives only in the OS keychain / keystore
// (expo-secure-store) and in memory; it is never written to AsyncStorage or logs.
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

import { PROVIDERS, type DebridId } from './providers';

const K_PROVIDER = 'huwa.debrid.provider';
const kKey = (id: DebridId) => `huwa.debrid.key.${id}`;

type State = { provider: DebridId | null; key: string | null; hydrated: boolean };
let state: State = { provider: null, key: null, hydrated: false };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};

let hydrating: Promise<void> | null = null;
export function hydrateDebrid() {
  hydrating ??= (async () => {
    try {
      const provider = (await SecureStore.getItemAsync(K_PROVIDER)) as DebridId | null;
      const key = provider && PROVIDERS[provider] ? await SecureStore.getItemAsync(kKey(provider)) : null;
      set({ provider: key ? provider : null, key, hydrated: true });
    } catch {
      set({ hydrated: true }); // SecureStore unavailable (web): no debrid
    }
  })();
  return hydrating;
}

export async function saveDebridKey(provider: DebridId, key: string) {
  const clean = key.trim();
  await PROVIDERS[provider].validate(clean);
  await SecureStore.setItemAsync(kKey(provider), clean);
  await SecureStore.setItemAsync(K_PROVIDER, provider);
  set({ provider, key: clean });
}

export async function clearDebrid() {
  const p = state.provider;
  if (p) await SecureStore.deleteItemAsync(kKey(p)).catch(() => {});
  await SecureStore.deleteItemAsync(K_PROVIDER).catch(() => {});
  set({ provider: null, key: null });
}

/** Active provider (no key exposed to the UI). */
export function useDebrid() {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      if (!state.hydrated) hydrateDebrid();
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
  return { provider: s.provider ? PROVIDERS[s.provider] : null, hydrated: s.hydrated };
}

export const getDebrid = () => (state.provider && state.key ? { provider: PROVIDERS[state.provider], key: state.key } : null);
export const subscribeDebrid = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
