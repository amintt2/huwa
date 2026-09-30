// SRT (SubRip) and WebVTT parsers. Both map onto the ASS model with a virtual 1000×1000 script
// (so WebVTT percentages become positions) and a neutral default style that the user style
// replaces at render time. Inline tags: see ./inline.
import { DEFAULT_STYLE } from './ass';
import { parseInline, spansText } from './inline';
import type { AssStyle, SubEvent, SubtitleDoc } from './types';

const RES = 1000;
/** Default text style for SRT/VTT, in the 1000-unit virtual script (≈ 5.5 % of the height). */
export const TEXT_STYLE: AssStyle = { ...DEFAULT_STYLE, name: 'Default', fontName: '', fontSize: 55, outlineWidth: 3, shadow: 1, marginL: 40, marginR: 40, marginV: 40 };

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d{1,3}))?/;

export function parseTimestamp(s: string): number {
  const m = TIME.exec(s.trim());
  if (!m) return NaN;
  const [, h, min, sec, ms] = m;
  return Number(h ?? 0) * 3600 + Number(min) * 60 + Number(sec) + Number((ms ?? '0').padEnd(3, '0')) / 1000;
}

type Placement = Pick<SubEvent, 'align' | 'pos'>;

/** WebVTT cue settings → alignment / position (line, position, align). */
export function vttPlacement(settings: string): Placement | null {
  const kv: Record<string, string> = {};
  for (const part of settings.trim().split(/\s+/)) {
    const [k, v] = part.split(':');
    if (k && v) kv[k.toLowerCase()] = v.toLowerCase();
  }
  if (!Object.keys(kv).length) return null;
  const al = kv.align;
  const col = al === 'start' || al === 'left' ? 0 : al === 'end' || al === 'right' ? 2 : 1;
  const posPct = kv.position ? parseFloat(kv.position) : NaN;
  const line = kv.line?.split(',')[0];
  if (line !== undefined && line !== 'auto') {
    if (line.endsWith('%')) {
      const pct = parseFloat(line);
      if (isFinite(pct)) {
        const x = isFinite(posPct) ? (posPct / 100) * RES : [0.05, 0.5, 0.95][col] * RES;
        // Line boxes are top-anchored by default: from the top half, anchor top; else bottom.
        return pct < 50 ? { align: 7 + col, pos: { x, y: (pct / 100) * RES } } : { align: 1 + col, pos: { x, y: (pct / 100) * RES } };
      }
    } else {
      const n = Number(line);
      if (isFinite(n)) return { align: (n >= 0 ? 7 : 1) + col };
    }
  }
  if (isFinite(posPct)) return { align: 1 + col, pos: { x: (posPct / 100) * RES, y: RES - TEXT_STYLE.marginV } };
  return { align: 1 + col };
}

function buildEvent(id: number, start: number, end: number, text: string, placement: Placement | null): SubEvent | null {
  const { spans, ev } = parseInline(text, TEXT_STYLE, { html: true, newlines: true });
  const plain = spansText(spans).trim();
  if (!plain) return null;
  return {
    id,
    start,
    end,
    layer: 0,
    style: TEXT_STYLE,
    spans,
    // Inline {\an8} (common in SRT) wins over cue settings.
    align: ev.align ?? placement?.align ?? 2,
    pos: ev.pos ? { x: (ev.pos.x / 384) * RES, y: (ev.pos.y / 288) * RES } : placement?.pos,
    marginL: 0,
    marginR: 0,
    marginV: 0,
    fade: ev.fade,
    plain,
  };
}

const doc = (format: 'srt' | 'vtt', events: SubEvent[]): SubtitleDoc => ({
  format,
  playResX: RES,
  playResY: RES,
  scaledBorder: true,
  wrapStyle: 0,
  styles: { Default: TEXT_STYLE },
  events: events.sort((a, b) => a.start - b.start || a.id - b.id),
});

/** SubRip. Tolerates missing indexes, `.` instead of `,`, extra coordinates and blank lines inside cues. */
export function parseSrt(raw: string): SubtitleDoc {
  const lines = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const events: SubEvent[] = [];
  let i = 0;
  let id = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.includes('-->')) {
      i++;
      continue;
    }
    const [a, b] = line.split('-->');
    const start = parseTimestamp(a);
    const end = parseTimestamp(b ?? '');
    i++;
    const body: string[] = [];
    // A cue ends at a blank line followed by an index + timing line (or at the next timing line).
    while (i < lines.length && !lines[i].includes('-->')) {
      if (!lines[i].trim()) {
        const nextNonEmpty = lines.slice(i + 1, i + 4).find((l) => l.trim());
        if (nextNonEmpty === undefined || /^\d+\s*$/.test(nextNonEmpty.trim()) || nextNonEmpty.includes('-->')) break;
      }
      body.push(lines[i]);
      i++;
    }
    // Drop the next cue's index if it was swallowed.
    if (body.length && /^\d+\s*$/.test(body[body.length - 1].trim()) && lines[i]?.includes('-->')) body.pop();
    if (isFinite(start) && isFinite(end) && end > start) {
      const ev = buildEvent(id++, start, end, body.join('\n'), null);
      if (ev) events.push(ev);
    }
  }
  return doc('srt', events);
}

/** WebVTT: skips NOTE / STYLE / REGION blocks, reads cue settings. */
export function parseVtt(raw: string): SubtitleDoc {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const events: SubEvent[] = [];
  let id = 0;
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const m = /^\s*(\S+)\s+-->\s+(\S+)(.*)$/.exec(lines[at]);
    if (!m) continue;
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2]);
    if (!isFinite(start) || !isFinite(end) || end <= start) continue;
    const ev = buildEvent(id++, start, end, lines.slice(at + 1).join('\n'), vttPlacement(m[3] ?? ''));
    if (ev) events.push(ev);
  }
  return doc('vtt', events);
}

export const isVtt = (text: string) => /^﻿?WEBVTT/.test(text.trimStart());
