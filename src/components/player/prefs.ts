// Player preferences remembered across episodes (speed, subtitle language & size, auto-next).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

export type SubtitleSize = 'S' | 'M' | 'L' | 'XL';
export const SUBTITLE_SIZES: Record<SubtitleSize, number> = { S: 14, M: 17, L: 21, XL: 26 };
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export type PlayerPrefs = {
  rate: number;
  /** Preferred subtitle language (`fr`, `en`…) or `off`. */
  subLang: string;
  subSize: SubtitleSize;
  autoNext: boolean;
  /** Landscape comments panel side. */
  commentsSide: 'left' | 'right';
  /** Time-anchored comments pop up over the video in fullscreen. */
  liveComments: boolean;
};

const KEY = 'huwa/player-prefs/v1';
let prefs: PlayerPrefs = { rate: 1, subLang: 'fr', subSize: 'M', autoNext: true, commentsSide: 'right', liveComments: true };
const listeners = new Set<() => void>();

AsyncStorage.getItem(KEY)
  .then((raw) => {
    if (!raw) return;
    prefs = { ...prefs, ...JSON.parse(raw) };
    listeners.forEach((l) => l());
  })
  .catch(() => {});

export const getPrefs = () => prefs;

export function setPrefs(patch: Partial<PlayerPrefs>) {
  prefs = { ...prefs, ...patch };
  listeners.forEach((l) => l());
  AsyncStorage.setItem(KEY, JSON.stringify(prefs)).catch(() => {});
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const usePrefs = () => useSyncExternalStore(subscribe, getPrefs, getPrefs);
