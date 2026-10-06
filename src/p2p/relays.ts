// Huwa relays (services/blind-peer): always-on blind peers that keep this account's cores (and
// pending messages, public rooms) available while every other device is offline. See
// src/p2p/worklet/relay.js for what is pushed, and site/privacy.html for what a relay sees.
//
// Default relay key(s): app config `extra.relayKeys` (env HUWA_RELAY_KEYS at build time, empty
// until the Huwa relay is deployed). The user can turn relays off and add their own.
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { useSyncExternalStore } from 'react';

import { registerRehydrate } from '@/settings/rehydrate';

export type RelayPrefs = {
  /** Relays on (only effective when at least one key is configured). */
  enabled: boolean;
  /** Keys added by the user (z32 or hex), on top of the default ones. */
  custom: string[];
  /** Default keys the user turned off. */
  disabledDefaults: string[];
};

export type RelayConfig = { enabled: boolean; keys: string[] };

const KEY = 'huwa/relays/v1';
const MAX_CUSTOM = 6;
const initial: RelayPrefs = { enabled: true, custom: [], disabledDefaults: [] };

const Z32 = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
const HEX = /^[0-9a-f]{64}$/;

/** A relay public key as printed by the relay (`publicKey` in its logs): z32 or hex, 32 bytes. */
export function isRelayKey(k: string): boolean {
  const s = k.trim().toLowerCase();
  return Z32.test(s) || HEX.test(s);
}

export const defaultRelayKeys: string[] = (() => {
  const raw = Constants.expoConfig?.extra?.relayKeys as unknown;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return [...new Set(list.filter((k): k is string => typeof k === 'string' && isRelayKey(k)).map((k) => k.trim().toLowerCase()))];
})();

let prefs: RelayPrefs = initial;
let loaded = false;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function emit() {
  listeners.forEach((l) => l());
}

export const relayPrefsReady = AsyncStorage.getItem(KEY)
  .then((raw) => {
    if (raw) prefs = { ...initial, ...JSON.parse(raw) };
  })
  .catch(() => {})
  .finally(() => {
    loaded = true;
    emit();
  });

registerRehydrate(async () => {
  clearTimeout(timer);
  const raw = await AsyncStorage.getItem(KEY).catch(() => null);
  try {
    prefs = raw ? { ...initial, ...JSON.parse(raw) } : initial;
  } catch {
    prefs = initial;
  }
  emit();
});

export function setRelayPrefs(update: (p: RelayPrefs) => RelayPrefs) {
  prefs = update(prefs);
  emit();
  clearTimeout(timer);
  timer = setTimeout(() => AsyncStorage.setItem(KEY, JSON.stringify(prefs)).catch(() => {}), 250);
}

export function addCustomRelay(key: string): string | null {
  const k = key.trim().toLowerCase();
  if (!isRelayKey(k)) return 'Clé invalide : colle la clé publique affichée par le relais (52 caractères z32 ou 64 hex).';
  if (defaultRelayKeys.includes(k) || prefs.custom.includes(k)) return 'Ce relais est déjà dans la liste.';
  if (prefs.custom.length >= MAX_CUSTOM) return `${MAX_CUSTOM} relais personnels au maximum.`;
  setRelayPrefs((p) => ({ ...p, custom: [...p.custom, k] }));
  return null;
}

export const getRelayPrefs = () => prefs;

/**
 * What the worklet uses. Off until the saved preferences are read: a user who turned relays off
 * never has them on, even for the first second after launch.
 */
export function relayConfig(p: RelayPrefs = prefs): RelayConfig {
  if (!loaded) return { enabled: false, keys: [] };
  const keys = [...defaultRelayKeys.filter((k) => !p.disabledDefaults.includes(k)), ...p.custom];
  return { enabled: p.enabled && keys.length > 0, keys };
}

/** Calls `cb` with the current config now (once loaded) and after every change. */
export function onRelayConfig(cb: (c: RelayConfig) => void): () => void {
  let last = '';
  const run = () => {
    if (!loaded) return;
    const c = relayConfig();
    const json = JSON.stringify(c);
    if (json === last) return;
    last = json;
    cb(c);
  };
  listeners.add(run);
  run();
  return () => {
    listeners.delete(run);
  };
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useRelayPrefs(): RelayPrefs {
  return useSyncExternalStore(subscribe, () => prefs, () => prefs);
}
