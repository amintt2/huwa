// Pure helpers for source chapters and title matching (kept free of native imports for tests).
import { shortHash } from './b64';
import type { ExtChapter } from './validate';

export type StoredChapter = ExtChapter & { id: string };

/** Language to show: the one picked before, then the app language, French, English, the most frequent. */
export function pickLang(chapters: Pick<ExtChapter, 'lang'>[], prefer?: string, appLang?: string): string {
  const counts = new Map<string, number>();
  for (const c of chapters) counts.set(c.lang, (counts.get(c.lang) ?? 0) + 1);
  for (const l of [prefer, appLang, 'fr', 'en']) if (l && counts.has(l)) return l;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
}

const numKey = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * One entry per chapter number in the chosen language (first one wins when several groups
 * translated it), ascending. Ids are `<seriesId>-c<number>` so progress on an AniList page
 * survives; chapters without a number go last with a hashed id.
 */
export function buildChapters(seriesId: string, all: ExtChapter[], lang: string): StoredChapter[] {
  const byNumber = new Map<string, ExtChapter>();
  const unnumbered: ExtChapter[] = [];
  for (const c of all) {
    if (c.lang !== lang) continue;
    if (!Number.isFinite(c.number) || c.number < 0) unnumbered.push(c);
    else if (!byNumber.has(numKey(c.number))) byNumber.set(numKey(c.number), c);
  }
  const numbered = [...byNumber.values()].sort((a, b) => a.number - b.number || (a.volume ?? 0) - (b.volume ?? 0));
  const last = numbered.length ? numbered[numbered.length - 1].number : 0;
  const extra = unnumbered.sort((a, b) => (a.sortingIndex ?? 0) - (b.sortingIndex ?? 0));
  return [
    ...numbered.map((c) => ({ ...c, id: `${seriesId}-c${numKey(c.number)}` })),
    ...extra.map((c, i) => ({ ...c, number: Math.floor(last) + i + 1, id: `${seriesId}-cx${shortHash(c.chapterId)}` })),
  ];
}

export function normTitle(s: string) {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s\-_:;,.!?'"’‘“”()[\]{}~・·/\\|&+*#@]+/g, '');
}

export type MatchTitles = {
  title: { english?: string | null; userPreferred?: string | null; romaji?: string | null; native?: string | null };
  synonyms?: string[] | null;
};

/** True when one of the source titles equals (normalized) one of the AniList titles or synonyms. */
export function titlesMatch(source: string[], media: MatchTitles): boolean {
  const mine = new Set(source.map(normTitle).filter((t) => t.length >= 3));
  return [media.title.english, media.title.userPreferred, media.title.romaji, media.title.native, ...(media.synonyms ?? [])]
    .filter((t): t is string => !!t)
    .some((t) => mine.has(normTitle(t)));
}
