// App settings (persisted locally). Other parts of the app read them through `useSettings()`:
//   - players: `wifiOnly`, `quality`, `subtitleSize` (see also `useStreamPolicy()` in ./network)
//   - notifications: `notifications`
//   - i18n: `lang`
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState, useSyncExternalStore } from 'react';

export type Lang = 'fr' | 'en';
export type Quality = 'auto' | '1080p' | '720p' | '480p';
export type SubtitleSize = 'small' | 'medium' | 'large';

export type Settings = {
  lang: Lang;
  /** Only start streams on Wi-Fi / Ethernet (players should check `useStreamPolicy()`). */
  wifiOnly: boolean;
  quality: Quality;
  subtitleSize: SubtitleSize;
  /** Local notifications for new episodes of series in "Ma liste". */
  notifications: boolean;
  /** We already asked for notification permission in context (never nag twice). */
  notificationsAsked: boolean;
  /** First-launch onboarding done. */
  onboarded: boolean;
};

export const SETTINGS_KEY = 'huwa/settings/v1';

export const DEFAULT_SETTINGS: Settings = {
  lang: 'fr',
  wifiOnly: false,
  quality: 'auto',
  subtitleSize: 'medium',
  notifications: false,
  notificationsAsked: false,
  onboarded: false,
};

/** Font size in points for each subtitle size setting. */
export const SUBTITLE_FONT: Record<SubtitleSize, number> = { small: 15, medium: 19, large: 24 };

let settings: Settings = DEFAULT_SETTINGS;
let hydrated = false;
let hydrating: Promise<void> | undefined;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function sanitize(raw: unknown): Settings {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  const pick = <K extends keyof Settings>(k: K, ok: (x: unknown) => boolean): Settings[K] =>
    ok(v[k]) ? (v[k] as Settings[K]) : DEFAULT_SETTINGS[k];
  const bool = (x: unknown) => typeof x === 'boolean';
  return {
    lang: pick('lang', (x) => x === 'fr' || x === 'en'),
    wifiOnly: pick('wifiOnly', bool),
    quality: pick('quality', (x) => ['auto', '1080p', '720p', '480p'].includes(x as string)),
    subtitleSize: pick('subtitleSize', (x) => ['small', 'medium', 'large'].includes(x as string)),
    notifications: pick('notifications', bool),
    notificationsAsked: pick('notificationsAsked', bool),
    onboarded: pick('onboarded', bool),
  };
}

/** Load settings from storage (idempotent). Called again after a data import. */
export function hydrateSettings(force = false): Promise<void> {
  if (hydrating && !force) return hydrating;
  hydrating = AsyncStorage.getItem(SETTINGS_KEY)
    .then((raw) => {
      if (raw) settings = sanitize(JSON.parse(raw));
    })
    .catch(() => {})
    .finally(() => {
      hydrated = true;
      emit();
    });
  return hydrating;
}

export function useSettingsHydrated() {
  const [ready, setReady] = useState(hydrated);
  useEffect(() => {
    if (!hydrated) hydrateSettings().then(() => setReady(true));
  }, []);
  return ready;
}

export function getSettings() {
  return settings;
}

/** Whole settings object (stable reference between changes). */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, () => settings, () => settings);
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  if (settings[key] === value) return;
  settings = { ...settings, [key]: value };
  emit();
  AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)).catch(() => {});
}
