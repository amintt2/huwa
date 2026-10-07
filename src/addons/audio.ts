// Audio / subtitle language of a stream, read from the release tags addons put in its name
// (VF, VOSTFR, MULTI, Dual Audio, flags…). Used to rank sources with the user's language
// preferences (Réglages → Langues, chosen in the onboarding).
//
// Release names are a guess: a "MULTI" may carry no French track, an untagged file may. When the
// file's real tracks are known (header sniff, see components/player/engines/tracks.ts and
// ./track-info.ts, or the player's own list) they override the name, in both directions
// (`classifyDub`, `langScore`'s `verified`).
//
// Detection rules (`detectLangs`), in this order:
//   1. Subtitle phrases are read first and removed, so their language never counts as audio:
//      VOSTFR / VOSTF / SUBFRENCH / ST FR (fr subs), VOSTA (en), VOSE (es), Legendado (pt),
//      "sub ITA", "subs: eng", "French subs", "sous-titres français", "Multi-Subs" (a marker that
//      also turns off bare 3-letter codes such as ITA, listed by multi-subtitle releases).
//   2. Audio, explicit: VF, VFF, VFQ, VFI, VF2, VOF, TRUEFRENCH, FRENCH, français, "French Dub"
//      (fr); "English Dub", "Eng Dub", "English Audio", bare "Dub" / "Dubbed" (en); Latino,
//      Castellano, Español, "Spanish Dub" / SPANISH (es); German, Deutsch, "German Dub" (de); ITA,
//      Italian(o) (it); Dublado, Português, "PT-BR Dub" (pt); JAP / JPN / Japanese / RAW / VO (ja).
//   3. Audio by convention (`implied`: to be confirmed by the file's tracks): MULTI = French + VO
//      (French scene); "Dual Audio" = English + Japanese unless it names its languages
//      ("Dual Audio FR", "Dual-Audio [Latino]", "Dual Áudio" = pt); SubsPlease / HorribleSubs =
//      Japanese only.
//   4. Flags (🇫🇷 🇬🇧 🇪🇸…) are audio, except a flag whose language only appears as subtitles
//      (Torrentio puts 🇫🇷 on a VOSTFR release).
import type { WatchMode } from '@/settings/settings';

import type { StreamItem } from './protocol';

export type StreamLangs = {
  audio: string[];
  subs: string[];
  label: string | null;
  /** Audio languages assumed from a convention (MULTI, Dual Audio): confirmed by the tracks only. */
  implied: string[];
};

const FLAGS: Record<string, string> = {
  '🇫🇷': 'fr', '🇨🇦': 'fr', '🇧🇪': 'fr', '🇬🇧': 'en', '🇺🇸': 'en', '🇪🇸': 'es', '🇲🇽': 'es', '🇦🇷': 'es', '🇩🇪': 'de', '🇮🇹': 'it',
  '🇵🇹': 'pt', '🇧🇷': 'pt', '🇯🇵': 'ja', '🇰🇷': 'ko', '🇸🇦': 'ar',
};
const FLAG_OF: Record<string, string> = { fr: '🇫🇷', en: '🇬🇧', es: '🇪🇸', de: '🇩🇪', it: '🇮🇹', pt: '🇧🇷', ja: '🇯🇵', ko: '🇰🇷', ar: '🇸🇦' };

// Language words as they appear next to "sub" in release names.
const SUB_LANG_WORDS: [string, string][] = [
  ['fr', 'fr|fre|fra|french|fran[cç]aise?'],
  ['en', 'en|eng|english|anglais'],
  ['es', 'es|esp|spa|spanish|espa[nñ]ol|castellano|latino'],
  ['de', 'de|ger|deu|german|deutsch'],
  ['it', 'it|ita|italian|italiano'],
  ['pt', 'pt|por|pt[-_ ]?br|portuguese|portugu[eê]s'],
  ['ja', 'ja|jp|jpn|jap|japanese'],
  ['ar', 'ar|ara|arabic'],
];
const SUB_WORD = '(?:sub(?:s|bed|titles?|titulado|titulos)?|softsubs?|hardsubs?|st|legendas?|sous[ ._-]?titres?|sottotitoli|untertitel)';
const SUB_PHRASES: [RegExp, string][] = SUB_LANG_WORDS.flatMap(([code, words]) => [
  [new RegExp(`\\b${SUB_WORD}[ ._:\\-\\[\\(]*(?:${words})\\b`, 'gi'), code],
  [new RegExp(`\\b(?:${words})[ ._-]*${SUB_WORD}\\b`, 'gi'), code],
] as [RegExp, string][]);

// Explicit audio tags (after the subtitle phrases are gone).
const AUDIO_TAGS: [RegExp, string][] = [
  [/\b(?:VFF|VFQ|VFI|VF2|VFi|VF|VOF|TRUEFRENCH|FRENCH|fran[cç]aise?)\b|\b(?:french|fr)[ ._-]?(?:dub(?:bed)?|audio)\b|\bdub(?:bed)?[ ._-]?(?:french|fr)\b/gi, 'fr'],
  [/\b(?:eng(?:lish)?[ ._-]?(?:dub(?:bed)?|audio)|dub(?:bed)?[ ._-]?eng(?:lish)?)\b/gi, 'en'],
  [/\b(?:latino|castellano|espa[nñ]ol|spanish|lat[ ._-]?dub|(?:spanish|esp?)[ ._-]?(?:dub(?:bed)?|audio))\b/gi, 'es'],
  [/\b(?:german|deutsch|ger[ ._-]?dub)\b/gi, 'de'],
  [/\b(?:italian[oa]?|ita[ ._-]?dub)\b/gi, 'it'],
  [/\b(?:dublado|portugu[eê]s|pt[-_ ]?br[ ._-]?(?:dub|audio)|brazilian)\b/gi, 'pt'],
  [/\b(?:JAP(?:ANESE)?|JPN|RAW|VO)\b/gi, 'ja'],
];
/** Bare 3-letter codes: only outside a multi-subtitle list. */
const BARE_CODES: [RegExp, string][] = [[/\bITA\b/g, 'it']];

const MULTI_SUBS = /\bmulti(?:ple)?[ ._-]?(?:subs?|subtitles?)\b|\bmultisubs?\b/gi;
const MULTI = /\bMULTI(?![ ._-]?(?:subs?|subtitles?|audio|dub))\b/i;
const DUAL = /\bdual[ ._-]?(a|á)udio\b/i;
// Languages a "Dual Audio" names next to it ("Dual Audio FR", "Dual-Audio [Latino]"). Short words
// that are also common words or other tags (en, es, it, de, BR) are left out.
const DUAL_LANGS: [RegExp, string][] = [
  [/\b(?:fr|fre|fra|vf|french)\b/i, 'fr'],
  [/\b(?:eng|english)\b/i, 'en'],
  [/\b(?:esp|spa|lat|latino|castellano|spanish)\b/i, 'es'],
  [/\b(?:ger|german)\b/i, 'de'],
  [/\b(?:ita|italian)\b/i, 'it'],
  [/\b(?:por|pt-br|portuguese)\b/i, 'pt'],
];
/** Fansub groups that only release Japanese audio. */
const SUB_ONLY_GROUPS = /\b(?:SubsPlease|HorribleSubs)\b/i;
/** Bare "Dub" / "Dubbed" (an English-language convention), not "Multi Dub". */
const BARE_DUB = /(?<!multi[ ._-]?)\bdub(?:bed)?\b/i;

const textOf = (s: StreamItem) => `${s.name ?? ''} ${s.title ?? ''} ${s.description ?? ''} ${s.behaviorHints?.filename ?? ''}`;

// Streams from the registry are stable objects: their reading is cached (ranking calls it often).
const memo = new WeakMap<object, StreamLangs>();

export function detectLangs(s: StreamItem): StreamLangs {
  const hit = memo.get(s);
  if (hit) return hit;
  const out = readLangs(s);
  memo.set(s, out);
  return out;
}

function readLangs(s: StreamItem): StreamLangs {
  const raw = textOf(s);
  const audio = new Set<string>();
  const explicit = new Set<string>();
  const implied = new Set<string>();
  const subs = new Set<string>();
  let t = ` ${raw} `;
  const cut = (re: RegExp, on: () => void) => {
    t = t.replace(re, () => {
      on();
      return ' ';
    });
  };

  // ---- 1. subtitles (removed from the text) ----
  let vostfr = false;
  cut(/\bVOST(?:FR?)?\b|\bSUB[ ._-]?FRENCH\b|\bST[ ._-]?FR\b/gi, () => {
    subs.add('fr');
    vostfr = true;
  });
  cut(/\bVOSTA\b/gi, () => subs.add('en'));
  cut(/\bVOSE\b/gi, () => subs.add('es'));
  cut(/\bLEGENDADO\b/gi, () => subs.add('pt'));
  const multiSubs = MULTI_SUBS.test(t);
  cut(MULTI_SUBS, () => {});
  for (const [re, code] of SUB_PHRASES) cut(re, () => subs.add(code));
  // A VO release subtitled in French (VOSTFR): Japanese audio.
  if (vostfr) explicit.add('ja');

  // ---- 2. explicit audio ----
  for (const [re, code] of AUDIO_TAGS) cut(re, () => explicit.add(code));
  if (!multiSubs) for (const [re, code] of BARE_CODES) cut(re, () => explicit.add(code));

  // ---- 3. conventions ----
  const multi = MULTI.test(t);
  if (multi) {
    // French scene MULTI = VF + VO, the VO subtitled in French inside the file.
    if (!explicit.has('fr')) implied.add('fr');
    explicit.add('ja');
    subs.add('fr');
  }
  const dual = DUAL.exec(t);
  if (dual) {
    const after = t.slice(dual.index + dual[0].length, dual.index + dual[0].length + 24);
    const before = t.slice(Math.max(0, dual.index - 16), dual.index);
    const named = DUAL_LANGS.filter(([re]) => re.test(after) || re.test(before)).map(([, c]) => c);
    if (named.length) named.forEach((c) => explicit.add(c));
    else if (![...explicit].some((c) => c !== 'ja')) implied.add(dual[1].toLowerCase() === 'á' ? 'pt' : 'en');
    explicit.add('ja');
  }
  // Bare "Dub": English, unless the release already names another dub language.
  if (!dual && BARE_DUB.test(t) && ![...explicit].some((c) => c !== 'ja')) explicit.add('en');
  if (SUB_ONLY_GROUPS.test(raw) && !explicit.size && !implied.size) explicit.add('ja');

  // ---- 4. flags ----
  for (const [flag, code] of Object.entries(FLAGS)) {
    if (!raw.includes(flag)) continue;
    // 🇫🇷 on a VOSTFR release: the subtitles' language, not a French track.
    if (subs.has(code) && !explicit.has(code) && !implied.has(code)) continue;
    explicit.add(code);
    implied.delete(code);
  }

  for (const c of explicit) audio.add(c);
  for (const c of implied) audio.add(c);
  return { audio: [...audio], subs: [...subs], label: labelOf(explicit, implied, subs, multi, !!dual), implied: [...implied] };
}

const SHORT: Record<string, string> = { es: 'ES', de: 'DE', it: 'ITA', pt: 'PT', ko: 'KO', ar: 'AR' };

function labelOf(explicit: Set<string>, implied: Set<string>, subs: Set<string>, multi: boolean, dual: boolean): string | null {
  const fr = explicit.has('fr') || implied.has('fr');
  if (multi) return '🇫🇷🇯🇵 MULTI';
  if (dual) {
    const other = [...explicit, ...implied].find((c) => c !== 'ja') ?? 'en';
    return `${FLAG_OF[other] ?? ''}🇯🇵 Dual Audio`;
  }
  if (fr) return subs.has('fr') ? '🇫🇷 VF + VOSTFR' : '🇫🇷 VF';
  if (subs.has('fr') && explicit.has('ja')) return '🇯🇵 VOSTFR';
  if (explicit.has('en')) return '🇬🇧 VA';
  const dub = [...explicit].find((c) => c !== 'ja' && SHORT[c]);
  if (dub) return `${FLAG_OF[dub] ?? ''} ${SHORT[dub]}`;
  return null;
}

/**
 * Subtitle languages carried by the stream itself: tags in its name (VOSTFR, MULTI, "subs FR"…)
 * plus the subtitle files it ships (`stream.subtitles`).
 */
export function streamSubLangs(s: StreamItem): string[] {
  const out = new Set(detectLangs(s).subs);
  for (const x of s.subtitles ?? []) if (x?.lang) out.add(normLang(x.lang));
  return [...out];
}

// ---------- dub mode ----------

/**
 * Audio languages of the file itself (header sniff or the player's list). `conclusive`: every
 * audio track states its language, so a language missing from `langs` is really missing.
 */
export type VerifiedAudio = { langs: string[]; conclusive: boolean };

/**
 * Where a stream stands for a dub: `dub` (the release says so, or its tracks), `maybe` (MULTI,
 * Dual Audio without its languages, untagged: only its tracks can tell), `no` (another language
 * only, or tracks without any preferred dub language).
 */
export type DubClass = { tier: 'dub' | 'maybe' | 'no'; lang?: string; verified: boolean };

export function classifyDub(s: StreamItem, dubLangs: string[], verified?: VerifiedAudio | null): DubClass {
  if (verified && verified.langs.length) {
    const hit = dubLangs.find((c) => verified.langs.includes(c));
    if (hit) return { tier: 'dub', lang: hit, verified: true };
    if (verified.conclusive) return { tier: 'no', verified: true };
  }
  const l = detectLangs(s);
  const named = l.audio.filter((c) => !l.implied.includes(c));
  const hit = dubLangs.find((c) => named.includes(c));
  if (hit) return { tier: 'dub', lang: hit, verified: false };
  if (dubLangs.some((c) => l.implied.includes(c))) return { tier: 'maybe', verified: false };
  // Nothing said about the audio (untagged), or only a convention in another language.
  if (!named.length) return { tier: 'maybe', verified: false };
  return { tier: 'no', verified: false };
}

/** Score of a stream that may be dubbed (`maybe`): after every named dub, before anything else. */
export const DUB_MAYBE = 5;
/** Scores from here on are not dubbed in a preferred language. */
export const NOT_DUBBED = 10;

/**
 * Lower is better. Unknown language is neutral (most anime releases are Japanese audio).
 * Sub mode: a stream that carries subtitles in a preferred language (in the file or attached)
 * ranks before an equal one without, so the race only compares those while any is alive.
 * Dub mode: named / verified dubs by language order (0, 1…), then `maybe` (`DUB_MAYBE`), then
 * everything else from `NOT_DUBBED` on, ranked as in sub mode (VOSTFR before raw).
 * `verified`: the file's own audio languages, when known (dub mode only).
 */
export function langScore(
  s: StreamItem,
  prefs: { watchMode: WatchMode; subLangs: string[]; dubLangs: string[]; translateSubs?: boolean },
  verified?: VerifiedAudio | null,
): number {
  if (prefs.watchMode === 'dub') {
    const d = classifyDub(s, prefs.dubLangs, verified);
    if (d.tier === 'dub') return Math.max(0, prefs.dubLangs.indexOf(d.lang!));
    if (d.tier === 'maybe') return DUB_MAYBE;
    return NOT_DUBBED + langScore(s, { ...prefs, watchMode: 'sub' });
  }
  const l = { ...detectLangs(s), subs: streamSubLangs(s) };
  const rank = (list: string[], have: string[]) => {
    const i = list.findIndex((c) => have.includes(c));
    return i < 0 ? list.length : i;
  };
  // Subtitled original with on-device translation: any subtitle track becomes one in the user's
  // language (embedded, attached or from a subtitles addon), so every Japanese / unknown-audio
  // release is as good as a VOSTFR one and the fastest wins. Dubbed-only releases stay last.
  if (prefs.translateSubs) return !l.audio.length || l.audio.includes('ja') ? 0 : 12;
  // Without translation: hardsubs in a preferred language first, then Japanese / unknown audio,
  // then dubbed-only releases last.
  const hard = rank(prefs.subLangs, l.subs);
  if (hard < prefs.subLangs.length) return hard;
  if (!l.audio.length || l.audio.includes('ja')) return 5;
  return 12;
}

const LANG_NAME: Record<string, string> = {
  fr: 'français', en: 'anglais', es: 'espagnol', de: 'allemand', it: 'italien', pt: 'portugais',
  ar: 'arabe', ja: 'japonais', ko: 'coréen', zh: 'chinois', ru: 'russe', hi: 'hindi',
};
const ISO3: Record<string, string> = {
  fre: 'fr', fra: 'fr', eng: 'en', spa: 'es', ger: 'de', deu: 'de', ita: 'it', por: 'pt', pob: 'pt',
  ara: 'ar', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', rus: 'ru', hin: 'hi',
};
/** "fre", "fr-FR", "French" → "fr". */
export function normLang(l: string): string {
  const x = l.trim().toLowerCase();
  if (ISO3[x]) return ISO3[x];
  const two = x.split(/[-_]/)[0];
  if (two.length === 2) return two;
  const byName = Object.entries(LANG_NAME).find(([, n]) => x.startsWith(n.slice(0, 4)) || x.startsWith(n));
  if (byName) return byName[0];
  const en: Record<string, string> = { french: 'fr', english: 'en', spanish: 'es', german: 'de', italian: 'it', portuguese: 'pt', arabic: 'ar', japanese: 'ja', korean: 'ko' };
  return en[x] ?? x;
}
const names = (codes: string[]) => codes.map((c) => LANG_NAME[c] ?? c).join(', ');

/** "VF" for French, otherwise "version espagnole"… (popups, next-episode card). */
export function dubName(lang: string): string {
  if (lang === 'fr') return 'VF';
  const adj: Record<string, string> = { en: 'anglaise', es: 'espagnole', de: 'allemande', it: 'italienne', pt: 'portugaise', ar: 'arabe', ja: 'japonaise', ko: 'coréenne' };
  return `version ${adj[lang] ?? lang}`;
}

/** "Pas de version française", "Pas de version anglaise"… */
export function noDubTitle(lang: string): string {
  const adj: Record<string, string> = { fr: 'française', en: 'anglaise', es: 'espagnole', de: 'allemande', it: 'italienne', pt: 'portugaise', ar: 'arabe', ko: 'coréenne' };
  return `Pas de version ${adj[lang] ?? `en ${LANG_NAME[lang] ?? lang}`}`;
}

/**
 * Name of what plays when the dub is missing, from the best non-dubbed stream: "VOSTFR" (VO with
 * French subtitles), "VO sous-titrée anglais", "VO" (subtitles unknown), or a dub in another
 * language ("VA", "version espagnole").
 */
export function fallbackName(s: StreamItem, subLangs: string[], translateSubs = false): string {
  const l = detectLangs(s);
  const subs = streamSubLangs(s);
  const named = l.audio.filter((c) => !l.implied.includes(c));
  const otherDub = named.find((c) => c !== 'ja');
  if (otherDub && !named.includes('ja')) return otherDub === 'en' ? 'VA' : dubName(otherDub);
  const sub = subLangs.find((c) => subs.includes(c));
  if (sub === 'fr') return 'VOSTFR';
  if (sub) return `VO sous-titrée ${LANG_NAME[sub] ?? sub}`;
  if (translateSubs || subLangs[0] === 'fr') return subLangs[0] === 'fr' ? 'VOSTFR' : 'VO sous-titrée';
  return 'VO';
}

/**
 * What the chosen source lacks compared with the user's languages, as a short French sentence,
 * or null when it matches (or nothing is known). `subtitleLangs`: languages actually available
 * (subtitles shipped with the stream + subtitles addons + full tracks embedded in the file, once
 * the player knows them + a translated track the device can produce).
 */
export function languageMismatch(
  s: StreamItem,
  prefs: { watchMode: WatchMode; subLangs: string[]; dubLangs: string[] },
  subtitleLangs: string[],
  verified?: VerifiedAudio | null,
): string | null {
  const l = { ...detectLangs(s), subs: streamSubLangs(s) };
  if (prefs.watchMode === 'dub') {
    const d = classifyDub(s, prefs.dubLangs, verified);
    if (d.tier !== 'no') return null;
    const audio = verified?.langs.length ? verified.langs : l.audio;
    return `Pas de version doublée en ${LANG_NAME[prefs.dubLangs[0]] ?? prefs.dubLangs[0]} : audio ${names(audio)}`;
  }
  const problems: string[] = [];
  if (l.audio.length && !l.audio.includes('ja')) problems.push(`audio ${names(l.audio)}`);
  const subs = [...new Set([...l.subs, ...subtitleLangs.map(normLang)])];
  if (!prefs.subLangs.some((c) => subs.includes(c))) {
    problems.push(subs.length ? `sous-titres ${names(subs.slice(0, 3))} seulement` : `aucun sous-titre en ${LANG_NAME[prefs.subLangs[0]] ?? prefs.subLangs[0]}`);
  }
  if (!problems.length) return null;
  const want = prefs.subLangs[0] === 'fr' ? 'VOSTFR' : `VO sous-titrée ${LANG_NAME[prefs.subLangs[0]] ?? prefs.subLangs[0]}`;
  return `Pas de ${want} trouvée : ${problems.join(', ')}`;
}
