// Subtitle fonts (SIL Open Font License, from @expo-google-fonts). Files are required one by one
// (never the package index, which would bundle every weight) and loaded on demand with expo-font.
//
// Default: Nunito — a rounded grotesque. For subtitles over moving pictures:
//   - rounded terminals keep the outline smooth (no spikes at stroke ends when the contour
//     is drawn around the glyphs), and the heavy weights survive a thick outline;
//   - generous x-height, open apertures (a e s c) and wide spacing stay legible at small sizes
//     and in motion, where condensed grotesques clog;
//   - full Latin Extended + Vietnamese + Cyrillic: every French accent, œ, «», ’, …;
//   - its soft shapes match the tone of anime fansubs (close to the classic "Gandhi Sans" look).
import * as Font from 'expo-font';
import { useEffect, useSyncExternalStore } from 'react';
import { Platform, type TextStyle } from 'react-native';

import type { FontId } from '@/subtitles/prefs';
import type { FontRef } from '@/subtitles/render';

type Files = { regular: number; bold: number; italic?: number; boldItalic?: number };

export type SubtitleFont = { id: FontId; label: string; hint: string; files?: Files };

export const SUBTITLE_FONTS: SubtitleFont[] = [
  {
    id: 'nunito',
    label: 'Nunito',
    hint: 'Arrondie et grasse, la plus lisible (par défaut)',
    files: {
      regular: require('@expo-google-fonts/nunito/600SemiBold/Nunito_600SemiBold.ttf'),
      bold: require('@expo-google-fonts/nunito/800ExtraBold/Nunito_800ExtraBold.ttf'),
      italic: require('@expo-google-fonts/nunito/600SemiBold_Italic/Nunito_600SemiBold_Italic.ttf'),
      boldItalic: require('@expo-google-fonts/nunito/800ExtraBold_Italic/Nunito_800ExtraBold_Italic.ttf'),
    },
  },
  { id: 'system', label: 'Système', hint: Platform.OS === 'ios' ? 'San Francisco' : 'Roboto' },
  {
    id: 'atkinson',
    label: 'Atkinson Hyperlegible',
    hint: 'Conçue pour les malvoyants',
    files: {
      regular: require('@expo-google-fonts/atkinson-hyperlegible/400Regular/AtkinsonHyperlegible_400Regular.ttf'),
      bold: require('@expo-google-fonts/atkinson-hyperlegible/700Bold/AtkinsonHyperlegible_700Bold.ttf'),
      italic: require('@expo-google-fonts/atkinson-hyperlegible/400Regular_Italic/AtkinsonHyperlegible_400Regular_Italic.ttf'),
      boldItalic: require('@expo-google-fonts/atkinson-hyperlegible/700Bold_Italic/AtkinsonHyperlegible_700Bold_Italic.ttf'),
    },
  },
  {
    id: 'mplus',
    label: 'M PLUS Rounded 1c',
    hint: 'Japonais (kana, kanji) et accents',
    files: {
      regular: require('@expo-google-fonts/m-plus-rounded-1c/500Medium/MPLUSRounded1c_500Medium.ttf'),
      bold: require('@expo-google-fonts/m-plus-rounded-1c/800ExtraBold/MPLUSRounded1c_800ExtraBold.ttf'),
    },
  },
  {
    id: 'comic',
    label: 'Comic Neue',
    hint: 'Bulle de manga, sobre',
    files: {
      regular: require('@expo-google-fonts/comic-neue/400Regular/ComicNeue_400Regular.ttf'),
      bold: require('@expo-google-fonts/comic-neue/700Bold/ComicNeue_700Bold.ttf'),
      italic: require('@expo-google-fonts/comic-neue/400Regular_Italic/ComicNeue_400Regular_Italic.ttf'),
      boldItalic: require('@expo-google-fonts/comic-neue/700Bold_Italic/ComicNeue_700Bold_Italic.ttf'),
    },
  },
  {
    id: 'merriweather',
    label: 'Merriweather',
    hint: 'Serif pour écrans',
    files: {
      regular: require('@expo-google-fonts/merriweather/400Regular/Merriweather_400Regular.ttf'),
      bold: require('@expo-google-fonts/merriweather/700Bold/Merriweather_700Bold.ttf'),
      italic: require('@expo-google-fonts/merriweather/400Regular_Italic/Merriweather_400Regular_Italic.ttf'),
      boldItalic: require('@expo-google-fonts/merriweather/700Bold_Italic/Merriweather_700Bold_Italic.ttf'),
    },
  },
  {
    id: 'mono',
    label: 'JetBrains Mono',
    hint: 'Chasse fixe',
    files: {
      regular: require('@expo-google-fonts/jetbrains-mono/500Medium/JetBrainsMono_500Medium.ttf'),
      bold: require('@expo-google-fonts/jetbrains-mono/800ExtraBold/JetBrainsMono_800ExtraBold.ttf'),
      italic: require('@expo-google-fonts/jetbrains-mono/500Medium_Italic/JetBrainsMono_500Medium_Italic.ttf'),
      boldItalic: require('@expo-google-fonts/jetbrains-mono/800ExtraBold_Italic/JetBrainsMono_800ExtraBold_Italic.ttf'),
    },
  },
];

const byId = new Map(SUBTITLE_FONTS.map((f) => [f.id, f]));
const familyName = (id: FontId, v: keyof Files) => `HuwaSub-${id}-${v}`;

const loading = new Map<FontId, Promise<void>>();
const loaded = new Set<FontId>(['system']);
const listeners = new Set<() => void>();
/** Loaded ids as a string: a new value on every load, so memoised renders see the change. */
let snapshot = 'system';
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getSnapshot = () => snapshot;

export function loadSubtitleFont(id: FontId): Promise<void> {
  if (loaded.has(id)) return Promise.resolve();
  const def = byId.get(id);
  if (!def?.files) return Promise.resolve();
  let p = loading.get(id);
  if (!p) {
    const map: Record<string, number> = {};
    for (const [k, v] of Object.entries(def.files)) if (v) map[familyName(id, k as keyof Files)] = v;
    p = Font.loadAsync(map)
      .then(() => {
        loaded.add(id);
        snapshot = [...loaded].sort().join(',');
        listeners.forEach((l) => l());
      })
      .catch(() => {
        loading.delete(id);
      });
    loading.set(id, p);
  }
  return p;
}

/**
 * Loads the given fonts and re-renders when they are ready. Returns the loaded font ids as a
 * string: pass it to `fontStyle` so memoised renders see the change.
 */
export function useSubtitleFonts(ids: FontId[]): string {
  const key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    for (const id of key.split(',')) if (id) void loadSubtitleFont(id as FontId);
  }, [key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const SYSTEM_WEIGHT = { regular: '500', bold: '800' } as const;

/** Text style for a font reference. Falls back to the system font until the file is loaded. */
export function fontStyle(ref: FontRef, bold: boolean, italic: boolean, loadedFonts: string): TextStyle {
  if (ref.kind === 'system') {
    return { fontFamily: ref.family, fontWeight: bold ? '700' : '400', fontStyle: italic ? 'italic' : 'normal' };
  }
  const def = byId.get(ref.id);
  if (!def?.files || !loadedFonts.split(',').includes(ref.id)) {
    return { fontWeight: bold ? SYSTEM_WEIGHT.bold : SYSTEM_WEIGHT.regular, fontStyle: italic ? 'italic' : 'normal' };
  }
  const f = def.files;
  const variant: keyof Files = italic ? (bold ? (f.boldItalic ? 'boldItalic' : 'bold') : f.italic ? 'italic' : 'regular') : bold ? 'bold' : 'regular';
  const hasItalic = variant === 'italic' || variant === 'boldItalic';
  // Custom families carry their weight: fontWeight must stay normal or Android picks another face.
  return { fontFamily: familyName(ref.id, variant), fontWeight: 'normal', fontStyle: italic && !hasItalic ? 'italic' : 'normal' };
}
