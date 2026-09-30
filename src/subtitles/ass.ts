// ASS (Advanced SubStation Alpha, v4+) and SSA (v4) parser — the fansub format.
// Reads [Script Info] (PlayResX/Y, WrapStyle, ScaledBorderAndShadow), [V4+ Styles] / [V4 Styles]
// and [Events] (Dialogue lines; Comment lines are skipped). [Fonts]/[Graphics] are ignored.
import { legacyAlign, parseAssColor, parseInline, spansText } from './inline';
import type { AssStyle, SubEvent, SubtitleDoc } from './types';

const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

export const DEFAULT_STYLE: AssStyle = {
  name: 'Default',
  fontName: 'Arial',
  fontSize: 20,
  primary: WHITE,
  secondary: { r: 255, g: 0, b: 0, a: 1 },
  outline: BLACK,
  back: { r: 0, g: 0, b: 0, a: 0.5 },
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  scaleX: 100,
  scaleY: 100,
  spacing: 0,
  borderStyle: 1,
  outlineWidth: 2,
  shadow: 2,
  alignment: 2,
  marginL: 10,
  marginR: 10,
  marginV: 10,
};

const V4P_STYLE_FORMAT =
  'Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';
const V4_STYLE_FORMAT =
  'Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding';
const V4P_EVENT_FORMAT = 'Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';
const V4_EVENT_FORMAT = 'Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';

const fields = (format: string) => format.split(',').map((f) => f.trim().toLowerCase());

/** `H:MM:SS.cc` → seconds. */
export function parseAssTime(s: string): number {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?\s*$/.exec(s);
  if (!m) return NaN;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

const assBool = (v: string | undefined, fallback: boolean) => {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return isFinite(n) ? n !== 0 : fallback;
};
const num = (v: string | undefined, fallback: number) => {
  const n = Number(v?.trim());
  return v !== undefined && v.trim() !== '' && isFinite(n) ? n : fallback;
};

function parseStyle(values: string[], format: string[], legacy: boolean): AssStyle {
  const get = (k: string) => {
    const i = format.indexOf(k);
    return i >= 0 ? values[i] : undefined;
  };
  // Name and font name may not contain commas, so a plain split is exact.
  const color = (k: string, fb: AssStyle['primary']) => {
    const v = get(k);
    return (v && parseAssColor(v)) || fb;
  };
  const align = num(get('alignment'), 2);
  const bold = get('bold');
  return {
    name: (get('name') ?? 'Default').trim(),
    fontName: (get('fontname') ?? 'Arial').trim(),
    fontSize: num(get('fontsize'), 20),
    primary: color('primarycolour', WHITE),
    secondary: color('secondarycolour', DEFAULT_STYLE.secondary),
    outline: legacy ? color('tertiarycolour', BLACK) : color('outlinecolour', BLACK),
    back: color('backcolour', DEFAULT_STYLE.back),
    // Bold is -1/0 (or a font weight in a few files).
    bold: bold !== undefined && (Number(bold) === -1 || Number(bold) === 1 || Number(bold) >= 600),
    italic: assBool(get('italic'), false),
    underline: assBool(get('underline'), false),
    strike: assBool(get('strikeout'), false),
    scaleX: num(get('scalex'), 100),
    scaleY: num(get('scaley'), 100),
    spacing: num(get('spacing'), 0),
    borderStyle: num(get('borderstyle'), 1),
    outlineWidth: Math.max(0, num(get('outline'), 2)),
    shadow: Math.max(0, num(get('shadow'), 0)),
    alignment: legacy ? legacyAlign(align) : align >= 1 && align <= 9 ? align : 2,
    marginL: num(get('marginl'), 10),
    marginR: num(get('marginr'), 10),
    marginV: num(get('marginv'), 10),
  };
}

/** Splits a line into `n` comma fields; the last one keeps its commas (the Text field). */
function splitN(line: string, n: number): string[] {
  const out: string[] = [];
  let rest = line;
  for (let i = 0; i < n - 1; i++) {
    const c = rest.indexOf(',');
    if (c < 0) break;
    out.push(rest.slice(0, c));
    rest = rest.slice(c + 1);
  }
  out.push(rest);
  return out;
}

export function isAss(text: string): boolean {
  return /^\s*\[Script Info\]/im.test(text.slice(0, 2000)) || /^\s*\[V4\+? Styles\]/im.test(text) || /^Dialogue:\s*/m.test(text.slice(0, 20000));
}

export function parseAss(raw: string): SubtitleDoc {
  const lines = raw.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const info: Record<string, string> = {};
  const styles: Record<string, AssStyle> = {};
  let section = '';
  let styleFormat: string[] | null = null;
  let eventFormat: string[] | null = null;
  let legacy = false;
  const dialogues: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimStart();
    if (!line || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]\s*$/.exec(line);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      if (section === 'v4 styles') legacy = true;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (section === 'script info') {
      info[key.toLowerCase()] = value.trim();
      if (key.toLowerCase() === 'scripttype' && /v4\.00(?!\+)/i.test(value)) legacy = true;
    } else if (section === 'v4+ styles' || section === 'v4 styles') {
      if (key === 'Format') styleFormat = fields(value);
      else if (key === 'Style') {
        const format = styleFormat ?? fields(legacy ? V4_STYLE_FORMAT : V4P_STYLE_FORMAT);
        const st = parseStyle(value.split(','), format, section === 'v4 styles');
        styles[st.name] = st;
      }
    } else if (section === 'events') {
      if (key === 'Format') eventFormat = fields(value);
      else if (key === 'Dialogue') dialogues.push(value);
    } else if (!section && key === 'Dialogue') {
      dialogues.push(value);
    }
  }

  // PlayRes: defaults per libass (384x288; a lone value implies 4:3, 1280x1024 special case).
  let playResX = num(info.playresx, 0);
  let playResY = num(info.playresy, 0);
  if (!playResX && !playResY) [playResX, playResY] = [384, 288];
  else if (!playResY) playResY = playResX === 1280 ? 1024 : Math.round((playResX * 3) / 4);
  else if (!playResX) playResX = playResY === 1024 ? 1280 : Math.round((playResY * 4) / 3);
  const wrapStyle = num(info.wrapstyle, 0);
  const scaledBorder = (info.scaledborderandshadow ?? 'yes').toLowerCase() !== 'no';

  const format = eventFormat ?? fields(legacy ? V4_EVENT_FORMAT : V4P_EVENT_FORMAT);
  const idx = (k: string) => format.indexOf(k);
  const [iLayer, iStart, iEnd, iStyle, iML, iMR, iMV, iText] = ['layer', 'start', 'end', 'style', 'marginl', 'marginr', 'marginv', 'text'].map(idx);
  const fallbackStyle = styles.Default ?? Object.values(styles)[0] ?? DEFAULT_STYLE;

  const events: SubEvent[] = [];
  dialogues.forEach((value, n) => {
    const v = splitN(value, format.length);
    const start = parseAssTime(v[iStart] ?? '');
    const end = parseAssTime(v[iEnd] ?? '');
    if (!isFinite(start) || !isFinite(end) || end <= start) return;
    const styleName = (v[iStyle] ?? '').trim();
    const style = styles[styleName] ?? styles[styleName.replace(/^\*/, '')] ?? fallbackStyle;
    const text = iText >= 0 ? (v[iText] ?? '') : v[v.length - 1];
    const { spans, ev } = parseInline(text, style, { html: false, newlines: false, wrapStyle, styles });
    const plain = spansText(spans).trim();
    if (!plain) return;
    events.push({
      id: n,
      start,
      end,
      layer: iLayer >= 0 ? num(v[iLayer], 0) : 0,
      style,
      spans,
      align: ev.align ?? style.alignment,
      pos: ev.pos,
      marginL: num(v[iML], 0),
      marginR: num(v[iMR], 0),
      marginV: num(v[iMV], 0),
      fade: ev.fade,
      plain,
    });
  });

  return {
    format: legacy ? 'ssa' : 'ass',
    playResX,
    playResY,
    scaledBorder,
    wrapStyle,
    styles,
    events: dedupeLayers(events).sort((a, b) => a.start - b.start || a.layer - b.layer || a.id - b.id),
  };
}

/**
 * Typesetters stack the same line on several layers (blurred border below, fill above). We draw
 * outline and fill ourselves, so keep only the top-most copy of identical lines.
 */
export function dedupeLayers(events: SubEvent[]): SubEvent[] {
  const best = new Map<string, SubEvent>();
  for (const e of events) {
    const k = `${e.start}|${e.end}|${e.align}|${e.pos ? `${e.pos.x},${e.pos.y}` : ''}|${e.plain}`;
    const prev = best.get(k);
    if (!prev || e.layer > prev.layer) best.set(k, e);
  }
  return events.filter((e) => best.get(`${e.start}|${e.end}|${e.align}|${e.pos ? `${e.pos.x},${e.pos.y}` : ''}|${e.plain}`) === e);
}
