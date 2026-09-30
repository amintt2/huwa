// Inline markup shared by every format:
//   - ASS override blocks {\i1\c&H00FFFF&\pos(10,20)…} (also found in many SRT files: {\an8})
//   - HTML-ish tags used by SRT/VTT: <i> <b> <u> <s> <font color face size> <c.yellow> <v Name> <ruby><rt>
// Produces spans (text + style overrides) and event-level overrides (\an, \pos, \fad…).
// Karaoke (\k), transforms (\t), clips, rotations and blur are ignored; drawings (\p1) are dropped.
import type { AssStyle, Rgba, Span, SpanStyle } from './types';

export type EventOverrides = {
  align?: number;
  pos?: { x: number; y: number };
  fade?: { in: number; out: number };
  wrapStyle?: number;
  /** A drawing (\p1) or clip-only vector sign was dropped. */
  hadDrawing?: boolean;
};

/** `&HAABBGGRR&`, `&HBBGGRR&`, `H00FFFFFF` or a decimal integer (SSA). */
export function parseAssColor(raw: string): Rgba | undefined {
  const s = raw.trim().replace(/&/g, '');
  let v: number;
  if (/^H/i.test(s)) {
    const hex = s.slice(1).replace(/[^0-9a-f]/gi, '');
    if (!hex) return undefined;
    v = parseInt(hex.slice(-8), 16);
  } else if (/^-?\d+$/.test(s)) {
    v = Number(s);
    if (v < 0) v = v >>> 0;
  } else return undefined;
  if (!isFinite(v)) return undefined;
  const a = (v >>> 24) & 0xff;
  return { r: v & 0xff, g: (v >>> 8) & 0xff, b: (v >>> 16) & 0xff, a: 1 - a / 255 };
}

/** `&H80&` → alpha 0..1 (ASS alpha is transparency). */
export function parseAssAlpha(raw: string): number | undefined {
  const hex = raw.replace(/[&H]/gi, '');
  const v = parseInt(hex, 16);
  return isFinite(v) ? 1 - (v & 0xff) / 255 : undefined;
}

const withAlpha = (c: Rgba | undefined, a: number): Rgba | undefined => (c ? { ...c, a } : undefined);

/** Legacy SSA alignment (1-3 bottom, 5-7 top, 9-11 middle) → numpad. */
export function legacyAlign(n: number): number {
  const h = ((n - 1) & 3) + 1; // 1..3
  if (n & 4) return 6 + h; // top
  if (n & 8) return 3 + h; // middle
  return h;
}

const nums = (args: string) =>
  args
    .replace(/^\(|\)$/g, '')
    .split(',')
    .map((x) => Number(x.trim()));

type Tag = { name: string; arg: string };

/** Splits `\i1\fnArial\pos(1,2)\t(0,100,\fs20)` into tags. */
export function splitTags(block: string): Tag[] {
  const out: Tag[] = [];
  let i = 0;
  while (i < block.length) {
    if (block[i] !== '\\') {
      i++;
      continue;
    }
    i++;
    let name: string;
    const rest = block.slice(i);
    if (/^fn/.test(rest)) name = 'fn';
    else if (rest[0] === 'r') name = 'r'; // \r and \rStyleName: the only tag starting with r
    else {
      const m = /^(\d?[a-zA-Z]+)/.exec(rest);
      if (!m) continue;
      name = m[1];
      // `\fsp`, `\fscx` are real tags; `\fs20` is fs + 20: letters are greedy, which is what we want.
    }
    i += name.length;
    let arg = '';
    if (block[i] === '(') {
      let depth = 0;
      const s = i;
      for (; i < block.length; i++) {
        if (block[i] === '(') depth++;
        else if (block[i] === ')' && --depth === 0) {
          i++;
          break;
        }
      }
      arg = block.slice(s, i);
    } else {
      const s = i;
      while (i < block.length && block[i] !== '\\') i++;
      arg = block.slice(s, i).trim();
    }
    out.push({ name, arg });
  }
  return out;
}

const bool = (arg: string, fallback: boolean) => (arg === '' ? fallback : Number(arg) !== 0);

/**
 * Applies one override block. `cur` is the running span style, `base` the event style
 * (for `\r` resets), `styles` the document styles (for `\rName`).
 */
function applyBlock(
  block: string,
  cur: SpanStyle,
  base: AssStyle,
  styles: Record<string, AssStyle> | undefined,
  ev: EventOverrides,
  state: { drawing: boolean },
): SpanStyle {
  let s: SpanStyle = { ...cur };
  for (const { name, arg } of splitTags(block)) {
    switch (name) {
      case 'i':
        s.italic = bool(arg, base.italic);
        break;
      case 'b': {
        if (arg === '') s.bold = base.bold;
        else {
          const n = Number(arg);
          s.bold = n === 1 || n >= 600 ? true : n === 0 ? false : n < 600 ? false : base.bold;
        }
        break;
      }
      case 'u':
        s.underline = bool(arg, base.underline);
        break;
      case 's':
        s.strike = bool(arg, base.strike);
        break;
      case 'fs': {
        const n = Number(arg);
        if (arg === '') delete s.fontSize;
        else if (/^[+-]/.test(arg)) s.fontSize = (s.fontSize ?? base.fontSize) + n;
        else if (n > 0) s.fontSize = n;
        break;
      }
      case 'fn':
        if (arg) s.fontName = arg;
        else delete s.fontName;
        break;
      case 'c':
      case '1c': {
        const c = arg ? parseAssColor(arg) : base.primary;
        if (c) s.color = { ...c, a: s.color?.a ?? base.primary.a };
        break;
      }
      case '3c': {
        const c = arg ? parseAssColor(arg) : base.outline;
        if (c) s.outlineColor = { ...c, a: s.outlineColor?.a ?? base.outline.a };
        break;
      }
      case '4c': {
        const c = arg ? parseAssColor(arg) : base.back;
        if (c) s.shadowColor = { ...c, a: s.shadowColor?.a ?? base.back.a };
        break;
      }
      case 'alpha': {
        const a = parseAssAlpha(arg);
        if (a !== undefined) {
          s.color = withAlpha(s.color ?? base.primary, a);
          s.outlineColor = withAlpha(s.outlineColor ?? base.outline, a);
          s.shadowColor = withAlpha(s.shadowColor ?? base.back, a);
        }
        break;
      }
      case '1a': {
        const a = parseAssAlpha(arg);
        if (a !== undefined) s.color = withAlpha(s.color ?? base.primary, a);
        break;
      }
      case '3a': {
        const a = parseAssAlpha(arg);
        if (a !== undefined) s.outlineColor = withAlpha(s.outlineColor ?? base.outline, a);
        break;
      }
      case '4a': {
        const a = parseAssAlpha(arg);
        if (a !== undefined) s.shadowColor = withAlpha(s.shadowColor ?? base.back, a);
        break;
      }
      case 'bord': {
        const n = Number(arg);
        if (isFinite(n) && n >= 0) s.outlineWidth = n;
        break;
      }
      case 'shad': {
        const n = Number(arg);
        if (isFinite(n) && n >= 0) s.shadow = n;
        break;
      }
      case 'an': {
        const n = Number(arg);
        if (ev.align === undefined && n >= 1 && n <= 9) ev.align = n;
        break;
      }
      case 'a': {
        const n = Number(arg);
        if (ev.align === undefined && n >= 1 && n <= 11) ev.align = legacyAlign(n);
        break;
      }
      case 'pos': {
        const [x, y] = nums(arg);
        if (!ev.pos && isFinite(x) && isFinite(y)) ev.pos = { x, y };
        break;
      }
      case 'move': {
        // Approximation: the sign stays at its starting point.
        const [x, y] = nums(arg);
        if (!ev.pos && isFinite(x) && isFinite(y)) ev.pos = { x, y };
        break;
      }
      case 'fad': {
        const [a, b] = nums(arg);
        if (!ev.fade && isFinite(a) && isFinite(b)) ev.fade = { in: Math.max(0, a), out: Math.max(0, b) };
        break;
      }
      case 'fade': {
        // \fade(a1,a2,a3,t1,t2,t3,t4) → in = t2 - t1, out = t4 - t3 (approximation).
        const v = nums(arg);
        if (!ev.fade && v.length >= 7 && v.every(isFinite)) ev.fade = { in: Math.max(0, v[4] - v[3]), out: Math.max(0, v[6] - v[5]) };
        break;
      }
      case 'q': {
        const n = Number(arg);
        if (n >= 0 && n <= 3) ev.wrapStyle = n;
        break;
      }
      case 'r': {
        const target = arg ? styles?.[arg] ?? styles?.[arg.replace(/^\*/, '')] : undefined;
        s = target ? styleDiff(base, target) : {};
        break;
      }
      case 'p': {
        const n = Number(arg);
        state.drawing = isFinite(n) && n > 0;
        if (state.drawing) ev.hadDrawing = true;
        break;
      }
      default:
        // k, K, kf, ko (karaoke), t, clip, iclip, org, frz, frx, fry, fax, fay, fscx, fscy, fsp,
        // be, blur, xbord, ybord, xshad, yshad, fe, pbo: not rendered.
        break;
    }
  }
  return s;
}

/** Span style that turns `base` into `target` (for `\rStyleName`). */
function styleDiff(base: AssStyle, target: AssStyle): SpanStyle {
  return {
    italic: target.italic,
    bold: target.bold,
    underline: target.underline,
    strike: target.strike,
    color: target.primary,
    outlineColor: target.outline,
    shadowColor: target.back,
    fontSize: target.fontSize,
    fontName: target.fontName !== base.fontName ? target.fontName : undefined,
    outlineWidth: target.outlineWidth,
    shadow: target.shadow,
  };
}

// ---------- HTML-ish tags (SRT / VTT) ----------

const NAMED: Record<string, string> = {
  white: '#ffffff', lime: '#00ff00', cyan: '#00ffff', red: '#ff0000', yellow: '#ffff00', magenta: '#ff00ff',
  blue: '#0000ff', black: '#000000', green: '#008000', orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', pink: '#ffc0cb', aqua: '#00ffff', fuchsia: '#ff00ff', maroon: '#800000', navy: '#000080', olive: '#808000', teal: '#008080',
};

export function parseCssColor(raw: string): Rgba | undefined {
  const s = raw.trim().toLowerCase().replace(/^["']|["']$/g, '');
  const hex = NAMED[s] ?? s;
  let m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/.exec(hex);
  if (m) {
    const v = parseInt(m[1], 16);
    return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  }
  m = /^#([0-9a-f]{3})$/.exec(hex);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const [r, g, b, a] = m[1].split(',').map((x) => Number(x.trim()));
    if ([r, g, b].every(isFinite)) return { r, g, b, a: isFinite(a) ? a : 1 };
  }
  return undefined;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', apos: "'", lrm: '‎', rlm: '‏' };
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });

export type InlineOptions = {
  /** Treat `<i>`… and entities (SRT / VTT). */
  html: boolean;
  /** ASS: `\n` is a soft break (space) unless WrapStyle 2; `\N` always breaks. */
  wrapStyle?: number;
  /** Real newlines in the text are line breaks (SRT / VTT). */
  newlines: boolean;
  styles?: Record<string, AssStyle>;
};

/** Parses one event's text into spans + event overrides. */
export function parseInline(text: string, base: AssStyle, opts: InlineOptions): { spans: Span[]; ev: EventOverrides } {
  const ev: EventOverrides = {};
  const spans: Span[] = [];
  const state = { drawing: false };
  let cur: SpanStyle = {};
  // Stack for HTML tags: restore the style that was active before the tag.
  const stack: { tag: string; prev: SpanStyle }[] = [];
  let buf = '';

  const flush = () => {
    if (!buf) return;
    const last = spans[spans.length - 1];
    if (last && sameStyle(last.style, cur)) last.text += buf;
    else spans.push({ text: buf, style: cur });
    buf = '';
  };
  const push = (t: string) => {
    if (!state.drawing) buf += t;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') {
      const close = text.indexOf('}', i + 1);
      if (close > i) {
        const block = text.slice(i + 1, close);
        if (block.includes('\\')) {
          flush();
          cur = applyBlock(block, cur, base, opts.styles, ev, state);
        }
        // A block without backslash is a comment in ASS: dropped either way.
        i = close + 1;
        continue;
      }
    }
    if (ch === '\\' && i + 1 < text.length) {
      const n = text[i + 1];
      if (n === 'N') {
        push('\n');
        i += 2;
        continue;
      }
      if (n === 'n') {
        push((ev.wrapStyle ?? opts.wrapStyle) === 2 ? '\n' : ' ');
        i += 2;
        continue;
      }
      if (n === 'h') {
        push(' ');
        i += 2;
        continue;
      }
    }
    if (opts.html && ch === '<') {
      const close = text.indexOf('>', i + 1);
      const raw = close > i ? text.slice(i, close + 1) : '';
      if (/^<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>$/.test(raw)) {
        // VTT karaoke timestamp <00:00:01.000>: ignored.
        i = close + 1;
        continue;
      }
      const m = raw ? /^<(\/?)([a-z0-9]+)(?:[.\s]([^>]*))?>$/i.exec(raw) : null;
      if (m) {
        const [, end, rawTag, attrs = ''] = m;
        const tag = rawTag.toLowerCase();
        if (['i', 'b', 'u', 's', 'font', 'c', 'v', 'lang', 'ruby', 'rt', 'span', 'em', 'strong'].includes(tag)) {
          flush();
          if (end) {
            const at = findLast(stack, tag);
            if (at >= 0) {
              cur = stack[at].prev;
              stack.length = at;
            }
            if (tag === 'rt') state.drawing = false;
          } else {
            stack.push({ tag, prev: cur });
            cur = { ...cur };
            if (tag === 'i' || tag === 'em') cur.italic = true;
            else if (tag === 'b' || tag === 'strong') cur.bold = true;
            else if (tag === 'u') cur.underline = true;
            else if (tag === 's') cur.strike = true;
            else if (tag === 'font') {
              const color = /color\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(attrs)?.[1];
              const c = color ? parseCssColor(color) : undefined;
              if (c) cur.color = c;
              const face = /face\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(attrs)?.[1];
              if (face) cur.fontName = face.replace(/^["']|["']$/g, '');
            } else if (tag === 'c') {
              // <c.yellow.bg_black>: first known colour class wins.
              for (const cls of attrs.split(/[.\s]/)) {
                const c = NAMED[cls.toLowerCase()] ? parseCssColor(cls) : undefined;
                if (c) {
                  cur.color = c;
                  break;
                }
              }
            } else if (tag === 'rt') state.drawing = true; // ruby annotation: hidden
          }
          i = close + 1;
          continue;
        }
      }
    }
    if (opts.html && ch === '&') {
      const semi = text.indexOf(';', i);
      if (semi > i && semi - i < 10) {
        const ent = decodeEntities(text.slice(i, semi + 1));
        if (ent !== text.slice(i, semi + 1)) {
          push(ent);
          i = semi + 1;
          continue;
        }
      }
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      push(opts.newlines ? '\n' : ' ');
      i++;
      continue;
    }
    push(ch);
    i++;
  }
  flush();
  return { spans: trimSpans(spans), ev };
}

function findLast(stack: { tag: string }[], tag: string) {
  for (let k = stack.length - 1; k >= 0; k--) if (stack[k].tag === tag) return k;
  return -1;
}

function sameStyle(a: SpanStyle, b: SpanStyle) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Removes leading/trailing blank lines and spaces; drops empty spans. */
function trimSpans(spans: Span[]): Span[] {
  const out = spans.filter((s) => s.text.length > 0);
  while (out.length && !out[0].text.replace(/^[ \t\n]+/, '')) out.shift();
  while (out.length && !out[out.length - 1].text.replace(/[ \t\n]+$/, '')) out.pop();
  if (!out.length) return out;
  out[0] = { ...out[0], text: out[0].text.replace(/^[ \t\n]+/, '') };
  const l = out.length - 1;
  out[l] = { ...out[l], text: out[l].text.replace(/[ \t\n]+$/, '') };
  return out.map((s) => ({ ...s, text: s.text.replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n') }));
}

export const spansText = (spans: Span[]) => spans.map((s) => s.text).join('');
