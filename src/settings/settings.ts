// App settings (persisted locally). Other parts of the app read them through `useSettings()`:
//   - players: `wifiOnly`, `quality`, `subtitleSize` (see also `useStreamPolicy()` in ./network)
//   - notifications: `notifications`
//   - i18n: `lang`
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { CELLULAR_DATA, type CellularData } from './network-budget';

export type Lang = 'fr' | 'en';
export type Quality = 'auto' | '1080p' | '720p' | '480p';
export type SubtitleSize = 'small' | 'medium' | 'large';
/** Anime: original Japanese audio with subtitles, or a dubbed version. */
export type WatchMode = 'sub' | 'dub';
/** ISO 639-1 codes, in order of preference (first = primary). */
export type LangList = string[];
export const LANG_CODES = ['fr', 'en', 'es', 'de', 'it', 'pt', 'ar', 'ja', 'ko'] as const;

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
  /** Default audio choice for anime (sources are ranked with it). */
  watchMode: WatchMode;
  /** Subtitle languages, primary first (auto-selected track). */
  subLangs: LangList;
  /** Dub languages, primary first (used when watchMode is 'dub'). */
  dubLangs: LangList;
  /**
   * Dub mode, no dub for an episode: play the best other version (VOSTFR…) without asking, with a
   * message saying so (otherwise a popup asks, see addons/dub.ts).
   */
  dubAutoFallback: boolean;
  /** No subtitle in the primary language but one in another: translate it on the device. */
  autoTranslateSubs: boolean;
  /** Reads manhwa at all (bridge prompts and manhwa suggestions). */
  readsManhwa: boolean;
  /** Chapter languages, primary first (chapter lists are filtered with it). */
  mangaLangs: LangList;
  /**
   * "Données mobiles": économie (Low Data Mode budgets), équilibré (near-Wi-Fi start, capped
   * background download), illimité (as on Wi-Fi). See ./network-budget.ts.
   */
  cellularData: CellularData;
  /** Move to a better / smoother source while playing (addons/source-controller.ts). */
  autoSwitchSource: boolean;
  /** Small message over the video when the source changed by itself. */
  switchToast: boolean;
  /**
   * HTTP links played by mpv go through the engine's loopback read-ahead proxy (head, end of file
   * and resume point fetched in parallel). Builds with the native engine only.
   */
  httpProxy: boolean;
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
  watchMode: 'sub',
  subLangs: ['fr', 'en'],
  dubLangs: ['fr'],
  dubAutoFallback: false,
  autoTranslateSubs: true,
  readsManhwa: true,
  mangaLangs: ['fr', 'en'],
  cellularData: 'balanced',
  autoSwitchSource: true,
  switchToast: true,
  httpProxy: true,
};

/** Font size in points for each subtitle size setting. */
export const SUBTITLE_FONT: Record<SubtitleSize, number> = { small: 15, medium: 19, large: 24 };

let settings: Settings = DEFAULT_SETTINGS;
let hydrated = false;
let hydrating: Promise<void> | undefined;
/** Set before the saved settings were read (first load only): re-applied on top of them. */
let early: Partial<Settings> | null = null;
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
  const langs = (x: unknown) => Array.isArray(x) && x.length > 0 && x.length <= 5 && x.every((c) => typeof c === 'string' && /^[a-z]{2}$/.test(c));
  return {
    lang: pick('lang', (x) => x === 'fr' || x === 'en'),
    wifiOnly: pick('wifiOnly', bool),
    quality: pick('quality', (x) => ['auto', '1080p', '720p', '480p'].includes(x as string)),
    subtitleSize: pick('subtitleSize', (x) => ['small', 'medium', 'large'].includes(x as string)),
    notifications: pick('notifications', bool),
    notificationsAsked: pick('notificationsAsked', bool),
    onboarded: pick('onboarded', bool),
    watchMode: pick('watchMode', (x) => x === 'sub' || x === 'dub'),
    subLangs: pick('subLangs', langs),
    dubLangs: pick('dubLangs', langs),
    dubAutoFallback: pick('dubAutoFallback', bool),
    autoTranslateSubs: pick('autoTranslateSubs', bool),
    readsManhwa: pick('readsManhwa', bool),
    mangaLangs: pick('mangaLangs', langs),
    cellularData: pick('cellularData', (x) => CELLULAR_DATA.includes(x as CellularData)),
    autoSwitchSource: pick('autoSwitchSource', bool),
    switchToast: pick('switchToast', bool),
    httpProxy: pick('httpProxy', bool),
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
      if (early) {
        settings = { ...settings, ...early };
        early = null;
        AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)).catch(() => {});
      }
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
  if (!hydrated) {
    early = { ...early, [key]: value };
    return;
  }
  AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)).catch(() => {});
}
