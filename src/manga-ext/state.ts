// Per-source storage, never shared with the app or other sources:
// - state (Paperback `Application.getState/setState`, 0.8 `SourceStateManager`) + cookie jar in
//   AsyncStorage under `huwa/pb/state/<sourceKey>`;
// - secure state (`getSecureState`, 0.8 keychain) in the Keychain via SecureStore, one entry per source.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { CookieJar } from './net';

const MAX_STATE_BYTES = 512 * 1024;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_SECURE_BYTES = 2048;
const MAX_KEY = 200;

type Saved = { state: Record<string, unknown>; cookies: unknown[] };
type Entry = Saved & { secure: Record<string, unknown>; jar: CookieJar; timer?: ReturnType<typeof setTimeout>; secureTimer?: ReturnType<typeof setTimeout> };

const entries = new Map<string, Entry>();
const loading = new Map<string, Promise<Entry>>();
const storageKey = (k: string) => `huwa/pb/state/${k}`;
const secureKey = (k: string) => `huwa.pb.${k.replace(/[^\w.-]/g, '_')}`;

function persist(key: string, e: Entry) {
  clearTimeout(e.timer);
  e.timer = setTimeout(() => {
    AsyncStorage.setItem(storageKey(key), JSON.stringify({ state: e.state, cookies: e.jar.toJSON() })).catch(() => {});
  }, 400);
}

export function loadSourceState(key: string): Promise<Entry> {
  const hit = entries.get(key);
  if (hit) return Promise.resolve(hit);
  const running = loading.get(key);
  if (running) return running;
  const p = (async () => {
    let saved: Saved = { state: {}, cookies: [] };
    let secure: Record<string, unknown> = {};
    try {
      const raw = await AsyncStorage.getItem(storageKey(key));
      if (raw) saved = { ...saved, ...(JSON.parse(raw) as Saved) };
    } catch {
      // corrupted: start empty
    }
    try {
      const raw = await SecureStore.getItemAsync(secureKey(key));
      if (raw) secure = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // unavailable (web) or corrupted
    }
    const e: Entry = { state: saved.state ?? {}, cookies: [], secure, jar: new CookieJar(saved.cookies) };
    e.jar = new CookieJar(saved.cookies, () => persist(key, e));
    entries.set(key, e);
    loading.delete(key);
    return e;
  })();
  loading.set(key, p);
  return p;
}

/** Cookie jar of a loaded source (the bridge loads the state before running the source). */
export function jarFor(key: string): CookieJar {
  const e = entries.get(key);
  if (e) return e.jar;
  // Not loaded yet: a throwaway jar (requests before load can't happen, this is defensive).
  return new CookieJar();
}

const size = (v: unknown) => {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Infinity;
  }
};

/** Writes one value coming from a sandbox. Oversized values are refused. */
export function setSourceValue(key: string, secure: boolean, name: unknown, value: unknown) {
  const e = entries.get(key);
  if (!e || typeof name !== 'string' || !name || name.length > MAX_KEY) return;
  if (size(value) > MAX_VALUE_BYTES) return;
  const target = secure ? e.secure : e.state;
  const prev = target[name];
  if (value === null || value === undefined) delete target[name];
  else target[name] = value;
  if (secure) {
    if (size(e.secure) > MAX_SECURE_BYTES) {
      if (prev === undefined) delete target[name];
      else target[name] = prev;
      return;
    }
    clearTimeout(e.secureTimer);
    e.secureTimer = setTimeout(() => {
      SecureStore.setItemAsync(secureKey(key), JSON.stringify(e.secure), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }).catch(() => {});
    }, 400);
    return;
  }
  if (size(e.state) > MAX_STATE_BYTES) {
    if (prev === undefined) delete target[name];
    else target[name] = prev;
    return;
  }
  persist(key, e);
}

export async function clearSourceState(key: string) {
  const e = entries.get(key);
  if (e) {
    clearTimeout(e.timer);
    clearTimeout(e.secureTimer);
  }
  entries.delete(key);
  await AsyncStorage.removeItem(storageKey(key)).catch(() => {});
  await SecureStore.deleteItemAsync(secureKey(key)).catch(() => {});
}
