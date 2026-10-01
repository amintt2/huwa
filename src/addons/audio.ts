// Audio / subtitle language of a stream, read from the release tags addons put in its name
// (VF, VOSTFR, MULTI, Dual Audio, flags…). Used to rank sources with the user's language
// preferences (Réglages → Langues, chosen in the onboarding).
import type { WatchMode } from '@/settings/settings';

import type { StreamItem } from './protocol';

export type StreamLangs = { audio: string[]; subs: string[]; label: string | null };

const FLAGS: Record<string, string> = {
  '🇫🇷': 'fr', '🇬🇧': 'en', '🇺🇸': 'en', '🇪🇸': 'es', '🇲🇽': 'es', '🇩🇪': 'de', '🇮🇹': 'it',
  '🇵🇹': 'pt', '🇧🇷': 'pt', '🇯🇵': 'ja', '🇰🇷': 'ko', '🇸🇦': 'ar',
};

export function detectLangs(s: StreamItem): StreamLangs {
  const text = `${s.name ?? ''} ${s.title ?? ''} ${s.description ?? ''} ${s.behaviorHints?.filename ?? ''}`;
  const audio = new Set<string>();
  const subs = new Set<string>();
  let label: string | null = null;
  if (/\bVOST(?:FR)?\b|\bsub(?:bed|s)?[ ._-]?fr(?:ench)?\b|\bfrench[ ._-]?subs?\b/i.test(text)) {
    subs.add('fr');
    audio.add('ja');
    label = '🇯🇵 VOSTFR';
  }
  if (/\bMULTI\b/i.test(text)) {
    audio.add('fr').add('ja');
    label = '🇫🇷🇯🇵 MULTI';
  }
  if (/\bdual[ ._-]?audio\b/i.test(text)) {
    audio.add('en').add('ja');
    label ??= '🇬🇧🇯🇵 Dual Audio';
  }
  if (/\b(?:VFF|VFQ|VFI|VF2|VF|TRUEFRENCH|FRENCH)\b|\bfran[cç]ais\b/i.test(text) && !subs.has('fr')) {
    audio.add('fr');
    label ??= '🇫🇷 VF';
  }
  if (/\b(?:eng(?:lish)?[ ._-]?dub(?:bed)?|dubbed)\b/i.test(text)) {
    audio.add('en');
    label ??= '🇬🇧 VA';
  }
  if (/\b(?:JAP(?:ANESE)?|JPN|RAW)\b/i.test(text)) audio.add('ja');
  for (const [flag, code] of Object.entries(FLAGS)) if (text.includes(flag)) audio.add(code);
  return { audio: [...audio], subs: [...subs], label };
}

/** Lower is better. Unknown language is neutral (most anime releases are Japanese audio). */
export function langScore(s: StreamItem, prefs: { watchMode: WatchMode; subLangs: string[]; dubLangs: string[] }): number {
  const l = detectLangs(s);
  const rank = (list: string[], have: string[]) => {
    const i = list.findIndex((c) => have.includes(c));
    return i < 0 ? list.length : i;
  };
  if (prefs.watchMode === 'dub') {
    const r = rank(prefs.dubLangs, l.audio);
    return r < prefs.dubLangs.length ? r : 10 + (l.audio.length ? 1 : 0);
  }
  // Subtitled original: hardsubs in a preferred language first, then Japanese / unknown audio,
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

/**
 * What the chosen source lacks compared with the user's languages, as a short French sentence,
 * or null when it matches (or nothing is known). `subtitleLangs`: languages actually available
 * (subtitles shipped with the stream + subtitles addons).
 */
export function languageMismatch(
  s: StreamItem,
  prefs: { watchMode: WatchMode; subLangs: string[]; dubLangs: string[] },
  subtitleLangs: string[],
): string | null {
  const l = detectLangs(s);
  if (prefs.watchMode === 'dub') {
    if (!l.audio.length || prefs.dubLangs.some((c) => l.audio.includes(c))) return null;
    return `Pas de version doublée en ${LANG_NAME[prefs.dubLangs[0]] ?? prefs.dubLangs[0]} : audio ${names(l.audio)}`;
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
