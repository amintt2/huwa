// Huwa design tokens — dark steel-blue streaming look.
// One accent (blue), one cool grey family, one radius scale:
//   chips 6 · controls 10 · cards 14 · sheets 28 · actions that float are circles.
import type { TextStyle } from 'react-native';

export const C = {
  bg: '#05070D',
  surface: '#0C111C',
  elevated: '#141B2B',
  border: 'rgba(120,140,180,0.18)',
  borderStrong: 'rgba(120,140,180,0.32)',
  text: '#F2F5FA',
  text2: '#9AA5BA',
  body: '#C3CBDA',
  /** The only accent. Fill for primary actions — white text on top (4.9:1). */
  accent: '#2F6BEB',
  /** Accent for text, icons and progress on dark surfaces (7:1). */
  accentText: '#7FB0FF',
  /** Tinted translucent fill for secondary actions and selected states. */
  accentSoft: 'rgba(47,107,235,0.22)',
  accentLine: 'rgba(127,176,255,0.35)',
  onAccent: '#FFFFFF',
  /** Neutral translucent pill (info pills, tags). */
  pill: 'rgba(90,100,130,0.28)',
  pillLine: 'rgba(120,130,160,0.30)',
  success: '#3DDC97',
  white: '#FFFFFF',
  black: '#000000',
} as const;

/** System font (SF Pro on iOS) — weights carry the hierarchy. */
export const F = {
  regular: { fontWeight: '400' },
  medium: { fontWeight: '500' },
  semibold: { fontWeight: '600' },
  bold: { fontWeight: '700' },
  heavy: { fontWeight: '800' },
  black: { fontWeight: '900' },
} as const satisfies Record<string, TextStyle>;

export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const R = { chip: 6, control: 10, card: 14, sheet: 28, pill: 999 } as const;

/** Strong ease-out for every UI transition (Emil Kowalski). */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;

export type Kind = 'anime' | 'manhwa';
export const kindLabel = (k: Kind) => (k === 'anime' ? 'ANIME' : 'MANHWA');
export const kindIcon = (k: Kind) => (k === 'anime' ? 'tv-outline' : 'book-outline') as 'tv-outline' | 'book-outline';

// Kept for call sites: both sections share the single accent, and differ by label + icon.
export const kindFill = (_k: Kind) => C.accent;
export const kindOnFill = (_k: Kind) => C.onAccent;
export const kindColor = (_k: Kind) => C.accentText;
export const kindSoft = (_k: Kind) => C.accentSoft;

/** Used only on anime ↔ manhwa bridge elements. */
export const BRIDGE = [C.accent, '#5A8CFF'] as const;
export const BRIDGE_SOFT = ['#0F1A33', '#0C111C'] as const;
