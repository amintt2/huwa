// Huwa design tokens — dark navy streaming look.
//
// Rules (stated once, never violated):
// · One accent (blue), one cool grey family.
// · Three surface tiers: base (`bg`) → raised (`surface`, cards and rows) → overlay (`elevated`,
//   controls on a card, sheets' inner rows). Each step up is lighter and carries a 1 px top highlight.
// · Shape: chips 8 · controls & buttons 12 · posters 10 · cards 16 · sheets 28 · floating round
//   actions are circles. Nested surfaces are concentric (outer = inner + padding).
// · Control heights: 44 (compact) · 50 (default) · 56 (hero). Every tap target ≥ 44 pt.
// · Uppercase only for small overline labels (`caption`); titles are sentence case.
import type { TextStyle } from 'react-native';

export const C = {
  bg: '#05070D',
  /** Raised: cards, rows, inputs on the base background. */
  surface: '#0C111C',
  /** Overlay: controls placed on a card, rows inside sheets. */
  elevated: '#151C2C',
  /** Bottom sheets and popovers. */
  sheet: '#0E1422',
  border: 'rgba(148,165,200,0.14)',
  borderStrong: 'rgba(148,165,200,0.30)',
  /** 1 px top inner highlight on raised surfaces (light from above). */
  highlight: 'rgba(255,255,255,0.07)',
  /** Neutral separator inside a surface. */
  hairline: 'rgba(255,255,255,0.08)',
  text: '#F2F5FA',
  body: '#C3CBDA',
  text2: '#9AA5BA',
  /** Tertiary text (timestamps, counters) — still 4.6:1 on `surface`. */
  text3: '#7E89A0',
  /** The only accent. Fill for primary actions — white text on top (4.9:1). */
  accent: '#2F6BEB',
  /** Top stop of the primary button gradient. */
  accentHi: '#4380F5',
  /** Accent for text, icons and progress on dark surfaces (7:1). */
  accentText: '#7FB0FF',
  /** Tinted translucent fill for secondary actions and selected states. */
  accentSoft: 'rgba(47,107,235,0.20)',
  accentLine: 'rgba(127,176,255,0.32)',
  onAccent: '#FFFFFF',
  /** Neutral translucent fill (tags, tonal buttons over art). */
  pill: 'rgba(255,255,255,0.08)',
  pillLine: 'rgba(255,255,255,0.10)',
  /** Glass over key art (fallback when Liquid Glass is unavailable). */
  glass: 'rgba(16,21,34,0.62)',
  glassLine: 'rgba(255,255,255,0.14)',
  /** Tonal secondary button on art: frosted white. */
  tonal: 'rgba(255,255,255,0.14)',
  tonalLine: 'rgba(255,255,255,0.12)',
  scrim: 'rgba(0,0,0,0.5)',
  star: '#FFC857',
  danger: '#FF7A7A',
  success: '#3DDC97',
  white: '#FFFFFF',
  black: '#000000',
} as const;

/** Elevation system (CSS box-shadow): one recipe per level, never decorative. */
export const SHADOW = {
  /** Cards and rows resting on the base background. */
  raised: '0px 1px 2px rgba(0,0,0,0.5), 0px 6px 16px -6px rgba(0,0,0,0.55)',
  /** Floating controls over art (glass buttons, pills). */
  float: '0px 2px 6px rgba(0,0,0,0.35), 0px 10px 24px -8px rgba(0,0,0,0.6)',
  /** Primary button: a short, tight drop shadow — lift, not glow. */
  primary: '0px 1px 2px rgba(0,0,0,0.5), 0px 8px 16px -8px rgba(0,0,0,0.8)',
  /** Bottom sheets. */
  sheet: '0px -10px 40px rgba(0,0,0,0.55)',
  /** Inner top highlight (inset) for raised controls. */
  inset: 'inset 0px 1px 0px rgba(255,255,255,0.10)',
  insetStrong: 'inset 0px 1px 0px rgba(255,255,255,0.24)',
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

/** Tabular numerals for anything that counts: times, episode numbers, scores. */
export const TABULAR = { fontVariant: ['tabular-nums'] } as const satisfies TextStyle;

export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const R = { chip: 8, control: 12, poster: 10, card: 16, sheet: 28, pill: 999 } as const;
/** Control heights: compact · default · hero. */
export const H = { sm: 44, md: 50, lg: 56 } as const;

/** Strong ease-out for every UI transition (Emil Kowalski). */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
/** iOS-like drawer curve, for sheets that are not finger-driven. */
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const;
/** Durations (ms): press-in, release, enter, exit — exits are faster than entrances. */
export const DUR = { press: 110, release: 180, enter: 280, exit: 200 } as const;
/** Springs — one vocabulary: `settle` (no bounce) and `sheet` (barely-there overshoot). */
export const SPRING = {
  settle: { duration: 400, dampingRatio: 1 },
  sheet: { duration: 420, dampingRatio: 0.88 },
} as const;

export type Kind = 'anime' | 'manhwa';
export const kindLabel = (k: Kind) => (k === 'anime' ? 'Anime' : 'Manhwa');
export const kindIcon = (k: Kind) => (k === 'anime' ? 'tv-outline' : 'book-outline') as 'tv-outline' | 'book-outline';

// Kept for call sites: both sections share the single accent, and differ by label + icon.
export const kindFill = (_k: Kind) => C.accent;
export const kindOnFill = (_k: Kind) => C.onAccent;
export const kindColor = (_k: Kind) => C.accentText;
export const kindSoft = (_k: Kind) => C.accentSoft;

/** Used only on anime ↔ manhwa bridge elements. */
export const BRIDGE = [C.accent, '#5A8CFF'] as const;
export const BRIDGE_SOFT = ['#0F1A33', '#0C111C'] as const;
