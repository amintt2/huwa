// Subtitle preferences (style + languages) and per-episode sync offsets, persisted locally.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { getSettings, setSetting } from '@/settings/settings';
import { registerRehydrate } from '@/settings/rehydrate';

export type FontId = 'nunito' | 'system' | 'atkinson' | 'mplus' | 'comic' | 'merriweather' | 'mono';
export type Background = 'none' | 'box' | 'band';

export type SubtitlePrefs = {
  /** Subtitles on by default when a track in a preferred language exists.
   *  The languages themselves are the app setting `subLangs` (onboarding / Général → Langues). */
  enabled: boolean;
  font: FontId;
  /** 0..5 (see SIZE_LEVELS). */
  size: number;
  color: string;
  /** 0..4 (see OUTLINE_LEVELS). */
  outline: number;
  outlineColor: string;
  /** 0..3 */
  shadow: number;
  background: Background;
  /** Background opacity 0..1. */
  bgOpacity: number;
  /** 0..4 (see POSITION_LEVELS). */
  position: number;
  bold: boolean;
  /** Render ASS files with their own fonts, colours and positions. */
  respectAss: boolean;
};

/** Font size as a share of the video height, with a floor for small inline players. */
export const SIZE_LEVELS = [
  { label: 'Très petite', pct: 0.046, min: 11 },
  { label: 'Petite', pct: 0.052, min: 12 },
  { label: 'Moyenne', pct: 0.059, min: 13 },
  { label: 'Grande', pct: 0.067, min: 14 },
  { label: 'Très grande', pct: 0.077, min: 16 },
  { label: 'Énorme', pct: 0.09, min: 18 },
] as const;

/** Outline width as a share of the font size. */
export const OUTLINE_LEVELS = [
  { label: 'Aucun', k: 0 },
  { label: 'Fin', k: 0.045 },
  { label: 'Normal', k: 0.075 },
  { label: 'Épais', k: 0.105 },
  { label: 'Très épais', k: 0.14 },
] as const;

/** Drop shadow distance as a share of the font size. */
export const SHADOW_LEVELS = [
  { label: 'Aucune', k: 0 },
  { label: 'Légère', k: 0.04 },
  { label: 'Moyenne', k: 0.07 },
  { label: 'Forte', k: 0.1 },
] as const;

/** Distance of the bottom line from the bottom of the video, share of its height. */
export const POSITION_LEVELS = [
  { label: 'Tout en bas', pct: 0.03 },
  { label: 'Bas', pct: 0.06 },
  { label: 'Un peu plus haut', pct: 0.1 },
  { label: 'Haut', pct: 0.15 },
  { label: 'Très haut', pct: 0.22 },
] as const;

export const TEXT_COLORS = [
  { label: 'Blanc', value: '#FFFFFF' },
  { label: 'Blanc cassé', value: '#F1EEE4' },
  { label: 'Jaune', value: '#FFE14D' },
  { label: 'Cyan', value: '#8FE3FF' },
  { label: 'Vert', value: '#B8F5A1' },
  { label: 'Rose', value: '#FFB8D6' },
] as const;

export const OUTLINE_COLORS = [
  { label: 'Noir', value: '#000000' },
  { label: 'Anthracite', value: '#1C1F26' },
  { label: 'Bleu nuit', value: '#0B1640' },
  { label: 'Bordeaux', value: '#3A0A14' },
  { label: 'Blanc', value: '#FFFFFF' },
] as const;

export const BG_OPACITIES = [0.35, 0.55, 0.75, 0.9] as const;

export const DEFAULT_SUBTITLE_PREFS: SubtitlePrefs = {
  enabled: true,
  font: 'nunito',
  size: 2,
  color: '#FFFFFF',
  outline: 2,
  outlineColor: '#000000',
  shadow: 1,
  background: 'none',
  bgOpacity: 0.55,
  position: 1,
  bold: true,
  respectAss: true,
};

const FONTS: FontId[] = ['nunito', 'system', 'atkinson', 'mplus', 'comic', 'merriweather', 'mono'];
const HEX = /^#[0-9A-F]{6}$/i;

export function sanitizeSubtitlePrefs(raw: unknown): SubtitlePrefs {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<SubtitlePrefs>;
  const d = DEFAULT_SUBTITLE_PREFS;
  const int = (x: unknown, max: number, fb: number) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= max ? x : fb);
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : d.enabled,
    font: FONTS.includes(v.font as FontId) ? (v.font as FontId) : d.font,
    size: int(v.size, SIZE_LEVELS.length - 1, d.size),
    color: typeof v.color === 'string' && HEX.test(v.color) ? v.color : d.color,
    outline: int(v.outline, OUTLINE_LEVELS.length - 1, d.outline),
    outlineColor: typeof v.outlineColor === 'string' && HEX.test(v.outlineColor) ? v.outlineColor : d.outlineColor,
    shadow: int(v.shadow, SHADOW_LEVELS.length - 1, d.shadow),
    background: v.background === 'box' || v.background === 'band' || v.background === 'none' ? v.background : d.background,
    bgOpacity: typeof v.bgOpacity === 'number' && v.bgOpacity >= 0 && v.bgOpacity <= 1 ? v.bgOpacity : d.bgOpacity,
    position: int(v.position, POSITION_LEVELS.length - 1, d.position),
    bold: typeof v.bold === 'boolean' ? v.bold : d.bold,
    respectAss: typeof v.respectAss === 'boolean' ? v.respectAss : d.respectAss,
  };
}

// ---------- store ----------

const KEY = 'huwa/subtitles/v1';
let prefs: SubtitlePrefs = DEFAULT_SUBTITLE_PREFS;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const loadPrefs = () =>
  AsyncStorage.getItem(KEY)
    .then((raw) => {
      prefs = raw ? sanitizeSubtitlePrefs(JSON.parse(raw)) : DEFAULT_SUBTITLE_PREFS;
      emit();
    })
    .catch(() => {});
loadPrefs();
registerRehydrate(loadPrefs);

export const getSubtitlePrefs = () => prefs;

export function setSubtitlePrefs(patch: Partial<SubtitlePrefs>) {
  prefs = sanitizeSubtitlePrefs({ ...prefs, ...patch });
  emit();
  AsyncStorage.setItem(KEY, JSON.stringify(prefs)).catch(() => {});
}

export function resetSubtitleStyle() {
  setSubtitlePrefs({ ...DEFAULT_SUBTITLE_PREFS, enabled: prefs.enabled });
}

/** Picking a track teaches the preferred language: moved to the front of `subLangs` (max 5). */
export function preferLanguage(lang: string) {
  setSubtitlePrefs({ enabled: true });
  const base = lang.split('-')[0];
  if (!/^[a-z]{2}$/.test(base)) return;
  const cur = getSettings().subLangs;
  if (cur[0] === base) return;
  setSetting('subLangs', [base, ...cur.filter((l) => l !== base)].slice(0, 5));
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useSubtitlePrefs = () => useSyncExternalStore(subscribe, getSubtitlePrefs, getSubtitlePrefs);

// ---------- per-episode sync offset ----------
// Positive = subtitles later (they wait `offset` seconds), like mpv's sub-delay.

const OFFSETS_KEY = 'huwa/subtitle-offsets/v1';
const MAX_OFFSETS = 400;
let offsets: Record<string, number> = {};
const offsetListeners = new Set<() => void>();

AsyncStorage.getItem(OFFSETS_KEY)
  .then((raw) => {
    if (!raw) return;
    const v = JSON.parse(raw);
    if (v && typeof v === 'object') offsets = { ...v, ...offsets };
    offsetListeners.forEach((l) => l());
  })
  .catch(() => {});
registerRehydrate(() =>
  AsyncStorage.getItem(OFFSETS_KEY)
    .then((raw) => {
      const v = raw ? JSON.parse(raw) : {};
      offsets = v && typeof v === 'object' ? v : {};
      offsetListeners.forEach((l) => l());
    })
    .catch(() => {}),
);

export const clampOffset = (s: number) => Math.round(Math.max(-60, Math.min(60, s)) * 10) / 10;

export function getSubtitleOffset(key: string | undefined): number {
  return key ? offsets[key] ?? 0 : 0;
}

export function setSubtitleOffset(key: string | undefined, seconds: number) {
  if (!key) return;
  const v = clampOffset(seconds);
  const next = { ...offsets };
  delete next[key]; // re-insert last: most recent entries survive the trim
  if (v !== 0) next[key] = v;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_OFFSETS))) delete next[k];
  offsets = next;
  offsetListeners.forEach((l) => l());
  AsyncStorage.setItem(OFFSETS_KEY, JSON.stringify(offsets)).catch(() => {});
}

const subscribeOffsets = (l: () => void) => {
  offsetListeners.add(l);
  return () => offsetListeners.delete(l);
};

export function useSubtitleOffset(key: string | undefined): number {
  return useSyncExternalStore(subscribeOffsets, () => getSubtitleOffset(key), () => getSubtitleOffset(key));
}
