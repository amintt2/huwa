// Persisted torrent settings (same tiny-store pattern as src/addons/registry.ts).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import type { TorrentSettings } from './types';
import { registerRehydrate } from '@/settings/rehydrate';

const KEY = 'huwa/torrent/settings/v1';
export const GB = 1024 * 1024 * 1024;
export const QUOTA_CHOICES = [2 * GB, 5 * GB, 10 * GB, 20 * GB] as const;

const defaults: TorrentSettings = { enabled: false, wifiOnly: true, quotaBytes: 5 * GB, legalAccepted: false };

let settings: TorrentSettings = defaults;
let hydrated: Promise<void> | undefined;
let loaded = false;
/** Changes made before the saved settings were read, re-applied on top of them. */
let early: Partial<TorrentSettings> | null = null;
const listeners = new Set<() => void>();

export const subscribeTorrentSettings = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useTorrentSettings() {
  return useSyncExternalStore(subscribeTorrentSettings, () => settings, () => settings);
}

export const getTorrentSettings = () => settings;

export function hydrateTorrentSettings() {
  if (!hydrated) {
    hydrated = AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (raw) settings = { ...defaults, ...(JSON.parse(raw) as Partial<TorrentSettings>) };
      })
      .catch(() => {})
      .finally(() => {
        loaded = true;
        if (early) {
          settings = { ...settings, ...early };
          early = null;
          AsyncStorage.setItem(KEY, JSON.stringify(settings)).catch(() => {});
        }
        listeners.forEach((l) => l());
      });
  }
  return hydrated;
}

registerRehydrate(() => {
  if (!hydrated) return;
  hydrated = undefined;
  settings = defaults;
  return hydrateTorrentSettings();
});

export function setTorrentSettings(patch: Partial<TorrentSettings>) {
  settings = { ...settings, ...patch };
  listeners.forEach((l) => l());
  if (loaded) AsyncStorage.setItem(KEY, JSON.stringify(settings)).catch(() => {});
  else {
    early = { ...early, ...patch };
    void hydrateTorrentSettings();
  }
  return settings;
}
