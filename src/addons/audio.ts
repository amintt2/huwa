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
