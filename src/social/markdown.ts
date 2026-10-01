// Safe Markdown subset for comments (pure, unit-tested), rendered as React Native Text spans
// (src/components/markdown.tsx) — never as HTML, never in a WebView.
//
// Blocks: paragraphs (single line breaks kept), > quotes, - / * / 1. lists, ``` code blocks.
// Inline: **bold**, *italic* / _italic_, ~~strike~~, `code`, ||spoiler||, [label](https://…),
// bare https links, and — depending on the thread — time anchors (12:47, 12:47–13:05) or page
// anchors (p. 12, p. 12–14). Backslash escapes a marker.
// Not supported on purpose: raw HTML (shown as text), images, headings, tables. Links are http(s)
// only, shown with their domain, and confirmed before opening.
import { findPageTokens, findTimeTokens, type Anchor, anchorLabel } from './anchors';

export type Inline =
  | { t: 'text'; s: string }
  | { t: 'br' }
  | { t: 'b' | 'i' | 's' | 'spoiler'; c: Inline[] }
  | { t: 'code'; s: string }
  | { t: 'link'; href: string; domain: string; c: Inline[] }
  | { t: 'anchor'; anchor: Anchor; s: string };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'quote'; c: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { t: 'code'; s: string };

export type MdOptions = { times?: boolean; pages?: boolean };

const MAX_DEPTH = 4;
const MAX_QUOTE_DEPTH = 2;
const MAX_URL = 500;

// ---------- links ----------

/** Domain of an http(s) URL that is safe to open, else undefined. */
export function safeLink(href: string): string | undefined {
  if (href.length > MAX_URL) return undefined;
  const m = /^https?:\/\/([^/?#\s]+)(?:[/?#]\S*)?$/i.exec(href);
  if (!m) return undefined;
  const host = m[1].toLowerCase();
  // No credentials ("user@host" phishing), only plain host names / IPs with an optional port.
  if (host.includes('@') || !/^[a-z0-9.-]+(?::\d{1,5})?$/.test(host) || !/[a-z0-9]/.test(host)) return undefined;
  return host.replace(/:\d+$/, '').replace(/^www\./, '');
}

// ---------- inline ----------

const PUNCT_ESCAPE = /[\\`*_~|[\]()>#+\-.!]/;
const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
const isAlnum = (ch: string | undefined) => !!ch && /[0-9A-Za-zÀ-ÖØ-öø-ÿ]/.test(ch);

/** Index of the closing delimiter, or -1. Content must be non-empty and not start/end with a space. */
function findClose(s: string, from: number, delim: string, opts: { intraword?: boolean } = {}): number {
  if (isSpace(s[from])) return -1;
  for (let j = from + 1; j <= s.length - delim.length; j++) {
    if (s[j] === '\\') {
      j++;
      continue;
    }
    if (s[j] === '`') {
      const end = s.indexOf('`', j + 1);
      if (end > 0) j = end;
      continue;
    }
    if (s.startsWith(delim, j) && !isSpace(s[j - 1])) {
      if (opts.intraword === false && isAlnum(s[j + delim.length])) continue;
      // `**` inside `*…*`: skip the double marker.
      if (delim === '*' && s[j + 1] === '*') {
        j++;
        continue;
      }
      // `***` closing `**…*…***`: the bold closes on the last two stars.
      if (delim === '**' && s[j + 2] === '*' && s[j + 3] !== '*') return j + 1;
      return j;
    }
  }
  return -1;
}

type Tok = { index: number; length: number; anchor: Anchor };

function anchorTokens(s: string, opts: MdOptions): Map<number, Tok> {
  const out = new Map<number, Tok>();
  if (opts.times) for (const t of findTimeTokens(s)) out.set(t.index, t);
  if (opts.pages) for (const t of findPageTokens(s)) if (!out.has(t.index)) out.set(t.index, t);
  return out;
}

function pushText(out: Inline[], s: string) {
  if (!s) return;
  const last = out[out.length - 1];
  if (last && last.t === 'text') last.s += s;
  else out.push({ t: 'text', s });
}

export function parseInline(s: string, opts: MdOptions = {}, depth = 0): Inline[] {
  const out: Inline[] = [];
  if (depth > MAX_DEPTH) {
    pushText(out, s);
    return out;
  }
  const anchors = anchorTokens(s, opts);
  let i = 0;
  let buf = '';
  const flush = () => {
    pushText(out, buf);
    buf = '';
  };
  const wrap = (t: 'b' | 'i' | 's' | 'spoiler', delim: string, intraword?: boolean) => {
    const end = findClose(s, i + delim.length, delim, { intraword });
    if (end < 0) return false;
    flush();
    out.push({ t, c: parseInline(s.slice(i + delim.length, end), opts, depth + 1) });
    i = end + delim.length;
    return true;
  };

  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && PUNCT_ESCAPE.test(s[i + 1] ?? '')) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      flush();
      out.push({ t: 'br' });
      i++;
      continue;
    }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1 && !s.slice(i + 1, end).includes('\n')) {
        flush();
        out.push({ t: 'code', s: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (s.startsWith('||', i) && wrap('spoiler', '||')) continue;
    if (s.startsWith('**', i) && wrap('b', '**')) continue;
    if (s.startsWith('~~', i) && wrap('s', '~~')) continue;
    if (ch === '*' && s[i + 1] !== '*' && wrap('i', '*')) continue;
    if (ch === '_' && !isAlnum(s[i - 1]) && wrap('i', '_', false)) continue;
    if (ch === '[') {
      const m = /^\[([^\]\n]{1,200})\]\(((?:[^\s()]|\([^\s()]*\)){1,500})\)/.exec(s.slice(i));
      if (m) {
        const domain = safeLink(m[2]);
        flush();
        if (domain) out.push({ t: 'link', href: m[2], domain, c: parseInline(m[1], {}, depth + 1) });
        else pushText(out, m[1]);
        i += m[0].length;
        continue;
      }
    }
    if ((ch === 'h' || ch === 'H') && !isAlnum(s[i - 1])) {
      const m = /^https?:\/\/[^\s<>]+/i.exec(s.slice(i));
      if (m) {
        const href = m[0].replace(/[.,;:!?)'"»]+$/, '');
        const domain = safeLink(href);
        if (domain) {
          flush();
          out.push({ t: 'link', href, domain, c: [{ t: 'text', s: domain }] });
          i += href.length;
          continue;
        }
      }
    }
    const tok = anchors.get(i);
    if (tok) {
      flush();
      out.push({ t: 'anchor', anchor: tok.anchor, s: s.slice(i, i + tok.length) });
      i += tok.length;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

// ---------- blocks ----------

const FENCE = /^\s*```/;
const QUOTE = /^\s*>\s?/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const ORDERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;

export function parseMarkdown(src: string, opts: MdOptions = {}, quoteDepth = 0): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    const text = para.join('\n').trim();
    if (text) blocks.push({ t: 'p', c: parseInline(text, opts) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      endPara();
      const code: string[] = [];
      let j = i + 1;
      while (j < lines.length && !FENCE.test(lines[j])) code.push(lines[j++]);
      // Unclosed fence: the rest is code.
      blocks.push({ t: 'code', s: code.join('\n').replace(/\s+$/, '') });
      i = j;
      continue;
    }
    if (QUOTE.test(line) && quoteDepth < MAX_QUOTE_DEPTH) {
      endPara();
      const inner: string[] = [];
      let j = i;
      while (j < lines.length && QUOTE.test(lines[j])) inner.push(lines[j++].replace(QUOTE, ''));
      blocks.push({ t: 'quote', c: parseMarkdown(inner.join('\n'), opts, quoteDepth + 1) });
      i = j - 1;
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      endPara();
      const isOrdered = !bullet;
      const items: Inline[][] = [];
      const start = ordered ? Number(ordered[1]) : 1;
      let j = i;
      for (; j < lines.length; j++) {
        const m = isOrdered ? ORDERED.exec(lines[j]) : BULLET.exec(lines[j]);
        if (!m) break;
        items.push(parseInline((isOrdered ? m[2] : m[1]).trim(), opts));
      }
      blocks.push({ t: 'list', ordered: isOrdered, start, items });
      i = j - 1;
      continue;
    }
    if (!line.trim()) {
      endPara();
      continue;
    }
    para.push(line);
  }
  endPara();
  return blocks;
}

// ---------- plain text (overlay, previews, notifications, share) ----------

const SPOILER_MASK = '▒▒▒▒▒';

export function inlineText(c: Inline[], { spoilers = false } = {}): string {
  return c
    .map((x) => {
      switch (x.t) {
        case 'text':
          return x.s;
        case 'br':
          return '\n';
        case 'code':
          return x.s;
        case 'anchor':
          return anchorLabel(x.anchor);
        case 'link':
          return inlineText(x.c, { spoilers });
        case 'spoiler':
          return spoilers ? inlineText(x.c, { spoilers }) : SPOILER_MASK;
        default:
          return inlineText(x.c, { spoilers });
      }
    })
    .join('');
}

/** Markdown → readable plain text; spoilers masked unless `spoilers`. */
export function plainText(src: string, opts: { spoilers?: boolean } = {}): string {
  const lines: string[] = [];
  const walk = (blocks: Block[], prefix: string) => {
    for (const b of blocks) {
      if (b.t === 'p') lines.push(prefix + inlineText(b.c, opts));
      else if (b.t === 'code') lines.push(prefix + b.s);
      else if (b.t === 'quote') walk(b.c, `${prefix}« `);
      else b.items.forEach((it, k) => lines.push(`${prefix}${b.ordered ? `${b.start + k}.` : '•'} ${inlineText(it, opts)}`));
    }
  };
  walk(parseMarkdown(src), '');
  return lines.join('\n').trim();
}

/** Does the text hide something behind ||…||? */
export const hasSpoilerSpan = (src: string) => /\|\|[^|\s][\s\S]*?\|\|/.test(src);
