// Lines of an embedded track read live from the video engine (see
// components/player/subtitles/live-translation.ts). mpv gives every event on screen as a full ASS
// line (`sub-text/ass-full`) and the track's header (`sub-ass-extradata`: script size, styles),
// so the lines become a regular ASS document. Two kinds of lines:
//   - spoken lines: translated and drawn like any subtitle;
//   - signs (on-screen text the typesetter placed over the picture): translated and drawn where
//     they are, smaller and in a box of their own, so the picture stays readable.
// Drawings, song lyrics in romaji / kanji and screens full of text are left out. Pure.
import { DEFAULT_STYLE, parseAss } from './ass';
import { KEEP_STYLE, translatedOnly } from './translate';
import type { AssStyle, SubEvent, SubtitleDoc } from './types';

export type LiveDoc = { doc: SubtitleDoc; signs: ReadonlySet<number> };

/** Placed, moved, rotated or clipped: typesetting of on-screen text, not a spoken line. */
const PLACED = /\{[^}]*\\(?:pos|move|org|i?clip|fr[xyz]?-?\d)/;
const SIGN_STYLE = /sign|^ts\b|typeset|screen|title|insert/i;
/** Vector drawing (\p1…): shapes, not text. */
const DRAWING = /\{[^}]*\\p[1-9]/;
/** Longer than any spoken line / any sign worth a note: a screen full of text. */
const MAX_SPOKEN = 200;
const MAX_SIGN = 250;
/**
 * Seconds a sign stays at least: motion-tracked signs are one event per frame, and mpv only
 * reports the first one (the text on screen does not change after it).
 */
const MIN_SIGN = 2;

const FORMAT = 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';

/** "Dialogue: …" lines of `sub-text/ass-full` (one per event on screen). */
export function assLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('Dialogue:'));
}

/** Seconds → ASS time ("0:01:02.34"). */
export function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** A plain line (older engine builds: no ASS events) as an ASS line. */
export function plainLine(start: number, end: number, text: string): string {
  return `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text.replace(/\n/g, '\\N')}`;
}

/** Text of an ASS event without override tags. */
const plainOf = (text: string) => text.replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, ' ').replace(/\\h/g, ' ').replace(/\s+/g, ' ').trim();

/** One letter repeated (a texture typeset in a symbol font): not text. */
const isTexture = (plain: string) => {
  const letters = plain.replace(/[^\p{L}]/gu, '');
  return letters.length > 6 && new Set(letters.toLowerCase()).size <= 2;
};

/** Text field and style of a "Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text" line. */
function fieldsOf(line: string): { style: string; text: string } | null {
  const f = line.replace(/^Dialogue:\s*/, '').split(',');
  return f.length < 10 ? null : { style: f[3].trim(), text: f.slice(9).join(',') };
}

/** `sub-ass-extradata` without its [Events] section (Matroska's has its own Format line). */
const headerOf = (header: string) => header.split(/^\s*\[Events\]\s*$/im)[0];

/**
 * The lines seen so far as one ASS document; `signs`: ids of its on-screen text events.
 * `withSigns` false: spoken lines only.
 */
export function liveDoc(header: string, lines: readonly string[], withSigns = true): LiveDoc {
  const kept: string[] = [];
  const signs = new Set<number>();
  for (const line of lines) {
    const f = fieldsOf(line);
    if (!f || DRAWING.test(f.text) || KEEP_STYLE.test(f.style)) continue;
    const plain = plainOf(f.text);
    if (!plain || isTexture(plain)) continue;
    const sign = PLACED.test(f.text) || SIGN_STYLE.test(f.style);
    if ((sign && !withSigns) || plain.length > (sign ? MAX_SIGN : MAX_SPOKEN)) continue;
    // parseAss numbers events by their line: the id says which kind it is.
    if (sign) signs.add(kept.length);
    kept.push(line);
  }
  const doc = parseAss(`${headerOf(header)}\n[Events]\n${FORMAT}\n${kept.join('\n')}`);
  // One note per sign: frames of a tracked sign merge into the first one.
  const open = new Map<string, SubEvent>();
  const events: SubEvent[] = [];
  for (const e of doc.events) {
    if (!signs.has(e.id)) {
      events.push(e);
      continue;
    }
    const prev = open.get(e.plain);
    if (prev && prev.end >= e.start - 0.05) {
      prev.end = Math.max(prev.end, e.end);
      continue;
    }
    const ev = { ...e, end: Math.max(e.end, e.start + MIN_SIGN) };
    open.set(e.plain, ev);
    events.push(ev);
  }
  return { doc: { ...doc, events }, signs };
}

/** Light yellow on a dark box, the user's font: reads as a note, not as the picture's own text. */
const NOTE: AssStyle = {
  ...DEFAULT_STYLE,
  name: 'Huwa-Note',
  fontName: '',
  primary: { r: 255, g: 238, b: 170, a: 1 },
  outline: { r: 0, g: 0, b: 0, a: 0.62 },
  back: { r: 0, g: 0, b: 0, a: 0 },
  borderStyle: 3,
  shadow: 0,
  italic: true,
  bold: false,
  scaleX: 100,
  scaleY: 100,
  spacing: 0,
};

/** Anchor of an event without \pos: where its alignment and margins put it. */
function anchorOf(e: SubEvent, doc: SubtitleDoc): { x: number; y: number } {
  const col = (e.align - 1) % 3;
  const row = Math.floor((e.align - 1) / 3);
  const mL = e.marginL || e.style.marginL;
  const mR = e.marginR || e.style.marginR;
  const mV = e.marginV || e.style.marginV;
  const x = col === 0 ? mL : col === 2 ? doc.playResX - mR : (doc.playResX + mL - mR) / 2;
  const y = row === 0 ? doc.playResY - mV : row === 2 ? mV : doc.playResY / 2;
  return { x, y };
}

/** A translated sign drawn as a note: same place, smaller, in a box. */
export function signNote(e: SubEvent, doc: SubtitleDoc): SubEvent {
  const size = Math.min(doc.playResY * 0.045, Math.max(doc.playResY * 0.03, (e.style.fontSize || 20) * 0.65));
  const style: AssStyle = { ...NOTE, fontSize: size, outlineWidth: size * 0.25 };
  return { ...e, style, spans: e.spans.map((s) => ({ text: s.text, style: {} })), pos: e.pos ?? anchorOf(e, doc), layer: e.layer + 100 };
}

/** What is drawn: translated lines only (the original never flashes first), signs as notes. */
export function translatedLive(live: LiveDoc, dict: ReadonlyMap<string, string>): SubtitleDoc {
  const out = translatedOnly(live.doc, dict);
  return { ...out, events: out.events.map((e) => (live.signs.has(e.id) ? signNote(e, live.doc) : e)) };
}
