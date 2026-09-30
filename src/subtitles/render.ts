// Turns a SubEvent into what the overlay draws (pixel sizes, CSS colours, placement), following
// either the file's own ASS style or the user's style. Pure: unit-tested, no React Native here.
import {
  BG_OPACITIES,
  OUTLINE_LEVELS,
  POSITION_LEVELS,
  SHADOW_LEVELS,
  SIZE_LEVELS,
  type FontId,
  type SubtitlePrefs,
} from './prefs';
import type { Rgba, SubEvent, SubtitleDoc } from './types';

export type FontRef = { kind: 'app'; id: FontId } | { kind: 'system'; family: string };

export type RenderSpan = {
  text: string;
  color: string;
  outlineColor: string;
  shadowColor: string;
  font: FontRef;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  fontSize: number;
};

export type Placement =
  | { kind: 'slot'; slot: number; marginL: number; marginR: number; marginV: number }
  | { kind: 'anchor'; x: number; y: number; align: number };

export type RenderBlock = {
  key: string;
  spans: RenderSpan[];
  /** Outline thickness in px (0 = none). */
  outline: number;
  /** Drop shadow distance in px (0 = none). */
  shadow: number;
  /** Opaque box behind the text (ASS BorderStyle 3 or the user's "box" background). */
  box?: { color: string; padH: number; padV: number; radius: number };
  opacity: number;
  placement: Placement;
  textAlign: 'left' | 'center' | 'right';
  lineHeight: number;
  /** Follows the user style (not the file's). */
  user: boolean;
};

export type Rect = { x: number; y: number; width: number; height: number };

export type RenderContext = {
  prefs: SubtitlePrefs;
  /** Where the video picture is drawn inside the overlay (contain fit). */
  video: Rect;
  /** Subtitle time (player time minus offset), seconds. */
  t: number;
};

export const css = (c: Rgba, alphaMul = 1) => `rgba(${c.r},${c.g},${c.b},${+(c.a * alphaMul).toFixed(3)})`;

export function hexToRgba(hex: string, a = 1): Rgba {
  const v = parseInt(hex.replace('#', ''), 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff, a };
}

// ---------- fonts named by ASS files ----------

const IOS_SYSTEM_FONTS = [
  'Arial', 'Arial Rounded MT Bold', 'Avenir', 'Avenir Next', 'Avenir Next Condensed', 'Chalkboard SE', 'Courier New', 'Futura', 'Georgia',
  'Gill Sans', 'Helvetica', 'Helvetica Neue', 'Marker Felt', 'Menlo', 'Noteworthy', 'Optima', 'Palatino', 'Times New Roman', 'Trebuchet MS', 'Verdana',
  'Hiragino Sans', 'Hiragino Mincho ProN', 'PingFang SC', 'PingFang TC',
];

/**
 * ASS files name fonts the phone rarely has (Gandhi Sans, Open Sans Semibold…). Known iOS fonts
 * are used as is; otherwise the closest bundled family, and the user's font for plain sans.
 */
export function resolveAssFont(name: string | undefined, userFont: FontId, platform: string): FontRef {
  const n = (name ?? '').replace(/^@/, '').trim();
  if (!n) return { kind: 'app', id: userFont };
  const lower = n.toLowerCase();
  if (platform === 'ios') {
    const sys = IOS_SYSTEM_FONTS.find((f) => f.toLowerCase() === lower);
    if (sys) return { kind: 'system', family: sys };
  }
  if (/mono|courier|consol|menlo|code/.test(lower)) return { kind: 'app', id: 'mono' };
  if (/comic|manga|anime ace|wild ?words|cc ?wild|bangers|chalk|marker|felt/.test(lower)) return { kind: 'app', id: 'comic' };
  if (/serif|times|georgia|garamond|minion|book|mincho|cambria|palatino|baskerville/.test(lower) && !/sans/.test(lower)) return { kind: 'app', id: 'merriweather' };
  if (/gothic|rounded|maru|m\+|mplus|hiragino|meiryo|yu |ms ?gothic|noto sans (?:cjk|jp)|source han|kozuka/.test(lower)) return { kind: 'app', id: 'mplus' };
  return { kind: 'app', id: userFont };
}

// ---------- event → block ----------

/** ASS sizes are cell heights; RN sizes are em. Ratio of a typical font's em to (ascent + descent). */
const EM_PER_CELL = 0.86;

export function userFontSize(prefs: SubtitlePrefs, videoHeight: number) {
  const lvl = SIZE_LEVELS[prefs.size] ?? SIZE_LEVELS[2];
  return Math.max(lvl.min, videoHeight * lvl.pct);
}

export function fadeOpacity(e: SubEvent, t: number): number {
  if (!e.fade) return 1;
  let o = 1;
  if (e.fade.in > 0) o = Math.min(o, ((t - e.start) * 1000) / e.fade.in);
  if (e.fade.out > 0) o = Math.min(o, ((e.end - t) * 1000) / e.fade.out);
  return Math.max(0, Math.min(1, o));
}

const alignH = (align: number) => ((align - 1) % 3 === 0 ? 'left' : (align - 1) % 3 === 2 ? 'right' : 'center');

export function renderEvent(e: SubEvent, doc: SubtitleDoc, ctx: RenderContext, platform = 'ios'): RenderBlock {
  const { prefs, video } = ctx;
  const isAssDoc = doc.format === 'ass' || doc.format === 'ssa';
  // Positioned signs keep their look even when the user style is forced: moving them around in
  // the dialogue font would put them on top of the dialogue.
  const assLook = isAssDoc && (prefs.respectAss || !!e.pos);
  const sy = video.height / doc.playResY;
  const sx = video.width / doc.playResX;
  const st = e.style;

  const userSize = userFontSize(prefs, video.height);
  const userColor = hexToRgba(prefs.color);
  const userOutline = hexToRgba(prefs.outlineColor);
  const userShadow = { r: 0, g: 0, b: 0, a: 0.75 };

  const spans: RenderSpan[] = e.spans.map((s) => {
    const ss = s.style;
    if (assLook) {
      return {
        text: s.text,
        color: css(ss.color ?? st.primary),
        outlineColor: css(ss.outlineColor ?? st.outline),
        shadowColor: css(ss.shadowColor ?? st.back),
        font: resolveAssFont(ss.fontName ?? st.fontName, prefs.font, platform),
        bold: ss.bold ?? st.bold,
        italic: ss.italic ?? st.italic,
        underline: ss.underline ?? st.underline,
        strike: ss.strike ?? st.strike,
        fontSize: Math.max(6, (ss.fontSize ?? st.fontSize) * sy * (st.scaleY / 100) * EM_PER_CELL),
      };
    }
    // User style; SRT/VTT colours (<font color>) are kept when "respect the video's style" is on.
    const keepColor = prefs.respectAss && !isAssDoc && ss.color;
    return {
      text: s.text,
      color: css(keepColor ? ss.color! : userColor),
      outlineColor: css(userOutline),
      shadowColor: css(userShadow),
      font: { kind: 'app', id: prefs.font },
      bold: prefs.bold || !!ss.bold,
      italic: !!ss.italic,
      underline: !!ss.underline,
      strike: !!ss.strike,
      fontSize: userSize,
    };
  });

  const baseSize = spans.reduce((m, s) => Math.max(m, s.fontSize), 0) || userSize;
  let outline: number;
  let shadow: number;
  let box: RenderBlock['box'];
  if (assLook) {
    const k = doc.scaledBorder ? sy : 1;
    const bord = (e.spans.find((s) => s.style.outlineWidth !== undefined)?.style.outlineWidth ?? st.outlineWidth) * k;
    const shad = (e.spans.find((s) => s.style.shadow !== undefined)?.style.shadow ?? st.shadow) * k;
    if (st.borderStyle === 3) {
      // Opaque box in the outline colour, padded by the outline width.
      box = { color: css(st.outline), padH: Math.max(2, bord), padV: Math.max(1, bord * 0.6), radius: 0 };
      outline = 0;
    } else outline = bord;
    shadow = shad;
  } else {
    outline = (OUTLINE_LEVELS[prefs.outline]?.k ?? 0) * baseSize;
    shadow = (SHADOW_LEVELS[prefs.shadow]?.k ?? 0) * baseSize;
    if (prefs.background === 'box') {
      box = { color: `rgba(0,0,0,${prefs.bgOpacity})`, padH: baseSize * 0.35, padV: baseSize * 0.12, radius: baseSize * 0.18 };
    }
  }

  let placement: Placement;
  if (e.pos) {
    placement = { kind: 'anchor', x: video.x + e.pos.x * sx, y: video.y + e.pos.y * sy, align: e.align };
  } else if (assLook) {
    placement = {
      kind: 'slot',
      slot: e.align,
      marginL: (e.marginL || st.marginL) * sx,
      marginR: (e.marginR || st.marginR) * sx,
      marginV: (e.marginV || st.marginV) * sy,
    };
  } else {
    const pos = POSITION_LEVELS[prefs.position] ?? POSITION_LEVELS[1];
    placement = { kind: 'slot', slot: e.align, marginL: video.width * 0.05, marginR: video.width * 0.05, marginV: video.height * pos.pct };
  }

  return {
    key: String(e.id),
    spans,
    outline: Math.min(outline, baseSize * 0.3),
    shadow: Math.min(shadow, baseSize * 0.3),
    box,
    opacity: fadeOpacity(e, ctx.t),
    placement,
    textAlign: alignH(e.align),
    lineHeight: baseSize * 1.22,
    user: !assLook,
  };
}

/** Background behind the whole bottom area ("bande"). */
export function bandColor(prefs: SubtitlePrefs) {
  return prefs.background === 'band' ? `rgba(0,0,0,${prefs.bgOpacity})` : undefined;
}

export { BG_OPACITIES };
