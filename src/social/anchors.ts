// Comment anchors (pure, unit-tested): a moment or a time range of an episode ("12:47",
// "12:47–13:05"), a page or a page range of a chapter ("p. 12", "p. 12–14").
//
// Wire format — nothing new on the network, so older peers keep accepting and showing these comments:
//   - anime: the existing `timestamp` field holds the start (older apps show it as a moment), and a
//     range is the text's leading token "12:47–13:05 …" (older apps show it as plain text);
//   - manhwa: the text's leading token "p. 12 …" / "p. 12–14 …".
// The leading token is shown as a chip and removed from the body. Tokens elsewhere in the text are
// detected too (tappable inline chips).

/** Longest accepted time range (a "time lapse" of a scene, not a whole episode). */
export const MAX_RANGE_SECONDS = 30 * 60;
/** Longest accepted page range. */
export const MAX_PAGE_SPAN = 50;
export const MAX_PAGE = 9999;
/** Same bound as the P2P schema's `timestamp`. */
export const MAX_SECONDS = 86400;

export type TimeAnchor = { type: 'time'; start: number; end?: number };
export type PageAnchor = { type: 'page'; from: number; to?: number };
export type Anchor = TimeAnchor | PageAnchor;

/** 767 → "12:47", 3723 → "1:02:03". */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** "12:47" → 767, "1:02:03" → 3723, anything else → undefined. */
export function parseTime(s: string): number | undefined {
  const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return undefined;
  const [a, b, c] = [Number(m[1]), Number(m[2]), m[3] === undefined ? undefined : Number(m[3])];
  let t: number;
  if (c === undefined) {
    // mm:ss — minutes up to 179 (a long episode / film without the hour).
    if (a > 179 || b > 59) return undefined;
    t = a * 60 + b;
  } else {
    if (a > 23 || b > 59 || c > 59 || m[1].length > 2) return undefined;
    t = a * 3600 + b * 60 + c;
  }
  return t <= MAX_SECONDS ? t : undefined;
}

export const isValidRange = (start: number, end: number) =>
  Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end - start <= MAX_RANGE_SECONDS && end <= MAX_SECONDS;

export const isValidPages = (from: number, to?: number) =>
  Number.isInteger(from) && from >= 1 && from <= MAX_PAGE && (to === undefined || (Number.isInteger(to) && to > from && to <= MAX_PAGE && to - from <= MAX_PAGE_SPAN));

/** Canonical text of an anchor, as the composer writes it ("12:47–13:05", "p. 12–14"). */
export function anchorLabel(a: Anchor): string {
  if (a.type === 'time') return a.end !== undefined ? `${fmtTime(a.start)}–${fmtTime(a.end)}` : fmtTime(a.start);
  return a.to !== undefined ? `p. ${a.from}–${a.to}` : `p. ${a.from}`;
}

/** Spoken label for screen readers. */
export function anchorA11y(a: Anchor): string {
  if (a.type === 'time') return a.end !== undefined ? `De ${fmtTime(a.start)} à ${fmtTime(a.end)}` : `À ${fmtTime(a.start)}`;
  return a.to !== undefined ? `Pages ${a.from} à ${a.to}` : `Page ${a.from}`;
}

// ---------- tokens in free text ----------

export type Token = { index: number; length: number; anchor: Anchor };

const TIME = '\\d{1,3}:\\d{2}(?::\\d{2})?';
const SEP = '\\s*(?:-|–|—|→|->|à)\\s*';
const TIME_RE = new RegExp(`(${TIME})(?:${SEP}(${TIME}))?`, 'g');
// "p. 12", "p.12", "pp. 12-14", "page 12", "pages 12 à 14", "pg 12".
const PAGE_RE = /(?:pp?\.\s?|pages?\s|pg\.?\s?)(\d{1,4})(?:\s*(?:-|–|—|à)\s*(\d{1,4}))?/gi;

const isWordChar = (ch: string | undefined) => !!ch && /[0-9A-Za-zÀ-ÖØ-öø-ÿ:]/.test(ch);

/** Time moments / ranges typed in a text ("à 12:47", "12:47-13:05"). */
export function findTimeTokens(text: string): Token[] {
  const out: Token[] = [];
  TIME_RE.lastIndex = 0;
  for (let m = TIME_RE.exec(text); m; m = TIME_RE.exec(text)) {
    const before = text[m.index - 1];
    const start = parseTime(m[1]);
    if (isWordChar(before) || start === undefined) continue;
    const end = m[2] !== undefined ? parseTime(m[2]) : undefined;
    if (end !== undefined && isValidRange(start, end) && !isWordChar(text[m.index + m[0].length])) {
      out.push({ index: m.index, length: m[0].length, anchor: { type: 'time', start, end } });
      continue;
    }
    // Not a valid range: keep the first time alone and rescan right after it.
    if (isWordChar(text[m.index + m[1].length])) continue;
    out.push({ index: m.index, length: m[1].length, anchor: { type: 'time', start } });
    TIME_RE.lastIndex = m.index + m[1].length;
  }
  return out;
}

/** Page references typed in a text ("p. 12", "pages 12-14"). */
export function findPageTokens(text: string): Token[] {
  const out: Token[] = [];
  PAGE_RE.lastIndex = 0;
  for (let m = PAGE_RE.exec(text); m; m = PAGE_RE.exec(text)) {
    if (isWordChar(text[m.index - 1])) continue;
    const from = Number(m[1]);
    const to = m[2] !== undefined ? Number(m[2]) : undefined;
    if (to !== undefined && isValidPages(from, to) && !/\d/.test(text[m.index + m[0].length] ?? '')) {
      out.push({ index: m.index, length: m[0].length, anchor: { type: 'page', from, to } });
      continue;
    }
    // The prefix ("p. ", "pages ") has no digit: the first number starts at indexOf.
    const len = m[0].indexOf(m[1]) + m[1].length;
    if (!isValidPages(from) || /\d/.test(text[m.index + len] ?? '')) continue;
    out.push({ index: m.index, length: len, anchor: { type: 'page', from } });
    PAGE_RE.lastIndex = m.index + len;
  }
  return out;
}

// ---------- the comment's own anchor ----------

export type AnchoredText = { anchor?: Anchor; body: string };

/** Strip the leading token (and the spaces / dash that follow it). */
const cut = (text: string, t: Token) => text.slice(t.index + t.length).replace(/^[\s:—–-]+/, '');

/**
 * Anchor of a comment and the text to show without its leading token.
 * `timestamp` is the P2P field (anime start); `target` decides between time and page anchors.
 */
export function commentAnchor(c: { text: string; timestamp?: number; target: string }): AnchoredText {
  const text = c.text;
  const lead = text.length - text.trimStart().length;
  if (c.target.startsWith('ch:')) {
    const t = findPageTokens(text)[0];
    if (t && t.index === lead) return { anchor: t.anchor, body: cut(text, t) };
    return { body: text };
  }
  const t = findTimeTokens(text)[0];
  const leading = t && t.index === lead ? (t.anchor as TimeAnchor) : undefined;
  if (typeof c.timestamp === 'number' && Number.isFinite(c.timestamp) && c.timestamp >= 0) {
    const start = Math.floor(c.timestamp);
    // The range token belongs to this anchor only when it starts at the stored moment.
    if (leading && leading.start === start && leading.end !== undefined) return { anchor: leading, body: cut(text, t!) };
    return { anchor: { type: 'time', start }, body: text };
  }
  if (leading) return { anchor: leading, body: cut(text, t!) };
  return { body: text };
}

/**
 * What the composer sends for an anchor: the text with its leading token, and the `timestamp`
 * field for anime (start of the moment or range).
 */
export function withAnchor(text: string, anchor: Anchor | undefined): { text: string; timestamp?: number } {
  const body = text.trim();
  if (!anchor) return { text: body };
  if (anchor.type === 'time') {
    const start = Math.floor(anchor.start);
    if (anchor.end === undefined) return { text: body, timestamp: start };
    return { text: `${anchorLabel({ type: 'time', start, end: Math.floor(anchor.end) })} ${body}`, timestamp: start };
  }
  return { text: `${anchorLabel(anchor)} ${body}` };
}

/** Is the playhead inside this anchor's window? A moment lasts `moment` seconds. */
export function isLive(a: TimeAnchor, t: number, moment = 7): boolean {
  if (a.end !== undefined) return t >= a.start && t < Math.max(a.end, a.start + moment);
  return t >= a.start && t - a.start < moment;
}

/** Does a page anchor cover this (1-based) page? */
export const coversPage = (a: PageAnchor, page: number) => page >= a.from && page <= (a.to ?? a.from);
