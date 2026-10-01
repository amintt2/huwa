// On-device subtitle translation, pure parts (the native calls, disk cache and React hook live in
// components/player/subtitles/translation.ts):
//   - when a translated track is needed: no full track in the primary language, one in another
//   - which cues to translate next: a window ahead of playback, so playback starts at once
//   - what text goes to the translator: the event's plain text (inline tags and line breaks out),
//     put back into the event afterwards (event-level overrides — \pos, \an, \fad, style — kept)
//   - cache keys per (subtitle URL, source, target)
import { langMatches, langName, normLang } from './lang';
import type { Track } from './select';
import type { Span, SubEvent, SubtitleDoc } from './types';

// ---------- when ----------

export type TranslatePlanPrefs = {
  /** Réglages → Sous-titres → "Traduire automatiquement si ta langue manque". */
  enabled: boolean;
  subLangs: string[];
  watchMode: 'sub' | 'dub';
};

/** Target language: the primary subtitle language, or null when translation makes no sense. */
export function translationTarget(tracks: Track[], prefs: Pick<TranslatePlanPrefs, 'subLangs' | 'watchMode'>): string | null {
  if (prefs.watchMode === 'dub' || !prefs.subLangs.length) return null;
  const target = normLang(prefs.subLangs[0]);
  if (target === 'und') return null;
  const native = tracks.some((t) => t.kind !== 'local' && t.kind !== 'translated' && !t.forced && langMatches(t.lang, target));
  return native ? null : target;
}

/**
 * Tracks that could be translated into the primary language, best first: only external files
 * (their text is readable; embedded tracks are drawn by the video engine), full tracks only, the
 * user's other languages in order, then English, then anything else; source order within one.
 */
export function translationSources(tracks: Track[], prefs: Pick<TranslatePlanPrefs, 'subLangs' | 'watchMode'>): Track[] {
  const target = translationTarget(tracks, prefs);
  if (!target) return [];
  const order = [...prefs.subLangs.slice(1).map((l) => normLang(l)), 'en'];
  const rank = (lang: string) => {
    const i = order.findIndex((p) => langMatches(lang, p));
    return i < 0 ? order.length : i;
  };
  return tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.kind === 'external' && !!t.url && !t.forced && t.lang !== 'und' && !langMatches(t.lang, target))
    .sort((a, b) => rank(a.t.lang) - rank(b.t.lang) || a.t.sourceRank - b.t.sourceRank || a.i - b.i)
    .map(({ t }) => t);
}

/** BCP 47 identifier for the native translator ("pt-br" → "pt-BR", "zh-tw" → "zh-Hant"). */
export function bcp47(lang: string): string {
  if (lang === 'zh-tw') return 'zh-Hant';
  if (lang === 'zh') return 'zh-Hans';
  if (lang === 'es-419') return 'es';
  const [base, region] = lang.split('-');
  return region ? `${base}-${region.toUpperCase()}` : base;
}

export const translatedTrackKey = (target: string, sourceUrl: string) => `tr:${target}:${sourceUrl}`;

export function translatedTrack(source: Track, target: string): Track {
  return {
    key: translatedTrackKey(target, source.url!),
    kind: 'translated',
    lang: target,
    source: 'Traduction',
    forced: false,
    name: `${langName(target)} (traduit automatiquement)`,
    // After every real track of the language.
    sourceRank: 99,
    url: source.url,
    fromLang: source.lang,
  };
}

// ---------- what ----------

/** Song lyrics in romaji / kanji and karaoke lines: left as they are. */
const KEEP_STYLE = /romaji|kanji|karaoke|\bkara\b|\bjp\b|\bjpn\b|japanese/i;
const LETTERS = /\p{L}{2,}/u;

/** Text units of an event: one per line for "- A / - B" dialogue, else the whole event on one line. */
export function eventSegments(e: SubEvent): string[] | null {
  if (KEEP_STYLE.test(e.style.name)) return null;
  const lines = e.plain.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!lines.length || !LETTERS.test(lines.join(' '))) return null;
  if (lines.length > 1 && lines.every((l) => /^[-–—]\s*\S/.test(l))) return lines.map((l) => l.replace(/^[-–—]\s*/, ''));
  return [lines.join(' ')];
}

/** Splits `text` into `n` lines of similar length at spaces (fewer when there are fewer words). */
export function wrapLines(text: string, n: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const count = Math.min(Math.max(1, n), words.length);
  if (count <= 1) return [words.join(' ')];
  // ends[i] = length of words[0..i] joined.
  const ends: number[] = [];
  words.forEach((w, i) => ends.push((i ? ends[i - 1] + 1 : 0) + w.length));
  const total = ends[ends.length - 1];
  const cuts: number[] = [];
  let prev = -1;
  for (let k = 1; k < count; k++) {
    const want = (total * k) / count;
    let best = prev + 1;
    // Leave at least one word for each remaining line.
    for (let i = prev + 1; i <= words.length - 1 - (count - k); i++) if (Math.abs(ends[i] - want) < Math.abs(ends[best] - want)) best = i;
    cuts.push(best);
    prev = best;
  }
  const out: string[] = [];
  let start = 0;
  for (const c of [...cuts, words.length - 1]) {
    out.push(words.slice(start, c + 1).join(' '));
    start = c + 1;
  }
  return out;
}

/** The span style that covers most of the text (inline tags collapse to it). */
function mainStyle(spans: Span[]): Span['style'] {
  let best: Span | undefined;
  for (const s of spans) if (!best || s.text.trim().length > best.text.trim().length) best = s;
  return best?.style ?? {};
}

/** Event with its text replaced by `translated` (one entry per segment), timing and placement kept. */
export function applyTranslation(e: SubEvent, translated: string[]): SubEvent {
  const lines = Math.min(3, e.plain.split('\n').filter((l) => l.trim()).length || 1);
  const style = mainStyle(e.spans);
  const text =
    translated.length > 1
      ? translated.map((t) => `- ${t.trim()}`).join('\n')
      : // Signs (\pos) keep their line count; dialogue is wrapped the same way, 2 lines at most.
        wrapLines(translated[0] ?? '', e.pos ? lines : Math.min(lines, 2)).join('\n');
  return { ...e, spans: [{ text, style }], plain: text };
}

/** `doc` with every translated event replaced (`dict`: source segment → translation). */
export function translateDoc(doc: SubtitleDoc, dict: ReadonlyMap<string, string>): SubtitleDoc {
  let changed = false;
  const events = doc.events.map((e) => {
    const segs = eventSegments(e);
    if (!segs || !segs.every((s) => dict.has(s))) return e;
    changed = true;
    return applyTranslation(e, segs.map((s) => dict.get(s)!));
  });
  return changed ? { ...doc, events } : doc;
}

// ---------- when (time) ----------

export type WindowOptions = {
  /** Seconds translated ahead of playback. */
  ahead: number;
  /** Seconds kept behind (a short seek back). */
  behind: number;
  /** Segments per native call. */
  max: number;
};

export const DEFAULT_WINDOW: WindowOptions = { ahead: 240, behind: 10, max: 48 };

/**
 * Next segments to translate around time `t`: events overlapping [t − behind, t + ahead], earliest
 * first, skipping what `known` already has, deduplicated (layered signs repeat their text).
 */
export function nextSegments(events: SubEvent[], t: number, known: (s: string) => boolean, opts: WindowOptions = DEFAULT_WINDOW): string[] {
  const from = t - opts.behind;
  const to = t + opts.ahead;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.start > to) break;
    if (e.end < from) continue;
    for (const s of eventSegments(e) ?? []) {
      if (seen.has(s) || known(s)) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= opts.max) return out;
    }
  }
  return out;
}

/** Share (0..1) of the translatable segments in the window that are already known. */
export function windowCoverage(events: SubEvent[], t: number, known: (s: string) => boolean, opts: WindowOptions = DEFAULT_WINDOW): number {
  const all = nextSegments(events, t, () => false, { ...opts, max: Infinity });
  return all.length ? all.filter(known).length / all.length : 1;
}

// ---------- cache ----------

/** FNV-1a 32-bit, hex. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** File-safe cache key of a translation (subtitle URL, source → target). */
export const translationCacheKey = (url: string, from: string, to: string) =>
  `v1-${fnv1a(url)}${fnv1a(`${url.length}|${url}`).slice(0, 4)}-${normLang(from)}-${normLang(to)}`;
