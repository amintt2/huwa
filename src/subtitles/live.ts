// Lines of an embedded track read live from the video engine (see
// components/player/subtitles/live-translation.ts), kept as plain cues. Pure.
import { KEEP_STYLE } from './translate';

export type LiveCue = { start: number; end: number; text: string };

/**
 * `list` with `cue` added (a line already there is kept). `replaces`: the engine reports what is on
 * screen now as one text, so an earlier line still running has been replaced and ends there; off
 * for lines that carry their own times.
 */
export function addCue(list: LiveCue[], cue: LiveCue, replaces = true): LiveCue[] {
  if (list.some((c) => Math.abs(c.start - cue.start) < 0.05 && c.text === cue.text)) return list;
  const kept = replaces ? list.map((c) => (c.start < cue.start && c.end > cue.start ? { ...c, end: cue.start } : c)) : list;
  return [...kept, cue];
}

export type AssLine = { start: number; end: number; style: string; text: string };

/** "0:01:02.34" → 62.34. */
function assTime(v: string): number {
  const m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(v.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
}

/**
 * mpv's `sub-text/ass-full`: one "Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,
 * Effect,Text" line per event on screen.
 */
export function parseAssFull(raw: string): AssLine[] {
  const out: AssLine[] = [];
  for (const line of raw.split('\n')) {
    const f = line.replace(/^\s*Dialogue:\s*/, '').split(',');
    if (f.length < 10) continue;
    const start = assTime(f[1]);
    const end = assTime(f[2]);
    if (!(start >= 0) || !(end > start)) continue;
    out.push({ start, end, style: f[3].trim(), text: f.slice(9).join(',') });
  }
  return out;
}

/** Placed, moved, rotated, clipped or drawn: typesetting of on-screen text, not a spoken line. */
const PLACED = /\{[^}]*\\(?:pos|move|org|i?clip|fr[xyz]?-?\d|p[1-9])/;
const SIGN_STYLE = /sign|^ts\b|typeset|screen|title|insert/i;
/** Longer than any spoken line: a screen full of text (a web page, a letter). */
const MAX_SPOKEN = 200;

/** Text of an ASS event without override tags ({…}), line breaks kept. */
export function assPlain(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Spoken lines among the events on screen, as cues with their own times. Signs (on-screen text,
 * placed by the typesetter), song lyrics in romaji / kanji and screens full of text are left out:
 * they are not translated, and not drawn while the translation is shown.
 */
export function spokenCues(raw: string): LiveCue[] {
  const out: LiveCue[] = [];
  for (const e of parseAssFull(raw)) {
    if (PLACED.test(e.text) || SIGN_STYLE.test(e.style) || KEEP_STYLE.test(e.style)) continue;
    const text = assPlain(e.text);
    if (text && text.length <= MAX_SPOKEN) out.push({ start: e.start, end: e.end, text });
  }
  return out;
}
