// Minimal i18n: flat FR/EN dictionaries, `{name}` interpolation, language from settings.
// Add a key to `fr` first (it defines the key type), then to `en` — TypeScript enforces parity.
import { getSettings, useSettings, type Lang } from '@/settings/settings';

import { en } from './en';
import { fr, type Key } from './fr';

export type { Key };
export type Vars = Record<string, string | number>;

const dicts: Record<Lang, Record<Key, string>> = { fr, en };

function format(s: string, vars?: Vars) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function translate(lang: Lang, key: Key, vars?: Vars) {
  return format(dicts[lang][key] ?? fr[key] ?? key, vars);
}

/** Non-React contexts (notification contents, alerts fired from async code). */
export const t = (key: Key, vars?: Vars) => translate(getSettings().lang, key, vars);

/** `const t = useT(); t('search.title')` — re-renders when the language changes. */
export function useT() {
  const { lang } = useSettings();
  return (key: Key, vars?: Vars) => translate(lang, key, vars);
}

export const localeOf = (lang: Lang) => (lang === 'en' ? 'en-US' : 'fr-FR');

export function useLocale() {
  return localeOf(useSettings().lang);
}

/** AniList genre names are English; show them in the UI language. */
export function genreLabel(lang: Lang, genre: string) {
  if (lang === 'en') return genre;
  return GENRES_FR[genre] ?? genre;
}

const GENRES_FR: Record<string, string> = {
  Action: 'Action',
  Adventure: 'Aventure',
  Comedy: 'Comédie',
  Drama: 'Drame',
  Fantasy: 'Fantasy',
  Horror: 'Horreur',
  'Mahou Shoujo': 'Magical girl',
  Mecha: 'Mecha',
  Music: 'Musique',
  Mystery: 'Mystère',
  Psychological: 'Psychologique',
  Romance: 'Romance',
  'Sci-Fi': 'Science-fiction',
  'Slice of Life': 'Tranche de vie',
  Sports: 'Sport',
  Supernatural: 'Surnaturel',
  Thriller: 'Thriller',
};
