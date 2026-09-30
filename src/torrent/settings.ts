// Persisted torrent settings (same tiny-store pattern as src/addons/registry.ts).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import type { TorrentSettings } from './types';

const KEY = 'huwa/torrent/settings/v1';
export const GB = 1024 * 1024 * 1024;
export const QUOTA_CHOICES = [2 * GB, 5 * GB, 10 * GB, 20 * GB] as const;

const defaults: TorrentSettings = { enabled: false, wifiOnly: true, quotaBytes: 5 * GB, legalAccepted: false };

let settings: TorrentSettings = defaults;
let hydrated: Promise<void> | undefined;
const listeners = new Set<() => void>();

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useTorrentSettings() {
  return useSyncExternalStore(subscribe, () => settings, () => settings);
}

export const getTorrentSettings = () => settings;

export function hydrateTorrentSettings() {
  if (!hydrated) {
    hydrated = AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (raw) settings = { ...defaults, ...(JSON.parse(raw) as Partial<TorrentSettings>) };
        listeners.forEach((l) => l());
      })
      .catch(() => {});
  }
  return hydrated;
}

export function setTorrentSettings(patch: Partial<TorrentSettings>) {
  settings = { ...settings, ...patch };
  listeners.forEach((l) => l());
  AsyncStorage.setItem(KEY, JSON.stringify(settings)).catch(() => {});
  return settings;
}
