// Subtitles drawn by mpv (tracks embedded in MKV/MP4, and styled ASS files handed to libass):
// the app's subtitle settings as mpv `sub-…` options, so they look like the overlay's. Pure.
//
// mpv sizes text subtitles in "scaled pixels" of a 720-line window: the overlay's shares of the
// video height become `share × 720`.
import {
  BG_OPACITIES,
  OUTLINE_LEVELS,
  POSITION_LEVELS,
  SHADOW_LEVELS,
  SIZE_LEVELS,
  type FontId,
  type SubtitlePrefs,
} from '@/subtitles/prefs';
import type { SubtitleDoc } from '@/subtitles/types';

/** Family names as CoreText knows them (libass falls back to a system font when one is missing). */
const FAMILY: Record<FontId, string> = {
  nunito: 'Nunito',
  system: 'Helvetica Neue',
  atkinson: 'Atkinson Hyperlegible',
  mplus: 'M PLUS Rounded 1c',
  comic: 'Comic Neue',
  merriweather: 'Merriweather',
  mono: 'JetBrains Mono',
};

const round1 = (n: number) => Math.round(n * 10) / 10;
/** `#RRGGBB` + opacity → mpv's `#AARRGGBB`. */
const withAlpha = (hex: string, opacity: number) =>
  `#${Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, '0').toUpperCase()}${hex.slice(1).toUpperCase()}`;

/**
 * `sub-…` options for the user's style and sync offset (s, + = later, as mpv's `sub-delay`).
 * ASS keeps its own look (`sub-ass-override=scale`) when "respect the video's style" is on;
 * otherwise it is restyled like plain subtitles (`force`).
 */
export function mpvSubtitleOptions(prefs: SubtitlePrefs, offset = 0): Record<string, string> {
  const size = Math.round(SIZE_LEVELS[prefs.size].pct * 720);
  const box = prefs.background !== 'none';
  return {
    'sub-ass-override': prefs.respectAss ? 'scale' : 'force',
    'sub-font': FAMILY[prefs.font] ?? FAMILY.nunito,
    'sub-font-size': String(size),
    'sub-bold': prefs.bold ? 'yes' : 'no',
    'sub-color': prefs.color.toUpperCase(),
    'sub-outline-color': prefs.outlineColor.toUpperCase(),
    'sub-outline-size': String(round1(OUTLINE_LEVELS[prefs.outline].k * size)),
    'sub-shadow-offset': String(round1(SHADOW_LEVELS[prefs.shadow].k * size)),
    'sub-border-style': box ? 'background-box' : 'outline-and-shadow',
    'sub-back-color': withAlpha('#000000', box ? prefs.bgOpacity || BG_OPACITIES[1] : 0),
    'sub-margin-y': String(Math.round(POSITION_LEVELS[prefs.position].pct * 720)),
    'sub-delay': String(Math.round(offset * 1000) / 1000),
  };
}

/**
 * An external ASS/SSA document is better drawn by libass than by the overlay when its own style
 * is kept: fonts, \clip, \t transforms, drawings, karaoke, rotations… all render as authored.
 */
export const libassRenders = (doc: SubtitleDoc | null, prefs: SubtitlePrefs) => !!doc && (doc.format === 'ass' || doc.format === 'ssa') && prefs.respectAss;
