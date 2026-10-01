// Pure helpers for source chapters and title matching (kept free of native imports for tests).
import { shortHash } from './b64';
import type { ExtChapter } from './validate';

export type StoredChapter = ExtChapter & { id: string };

/**
 * Language to show: the one picked before for this series, then the user's reading languages
 * (Réglages → Langues), the app language, French, English, the most frequent.
 */
export function pickLang(chapters: Pick<ExtChapter, 'lang'>[], prefer?: string, appLang?: string, readingLangs: string[] = []): string {
  const counts = new Map<string, number>();
  for (const c of chapters) counts.set(c.lang, (counts.get(c.lang) ?? 0) + 1);
  for (const l of [prefer, ...readingLangs, appLang, 'fr', 'en']) if (l && counts.has(l)) return l;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
}

const numKey = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * One entry per chapter number in the chosen language (first one wins when several groups
 * translated it), ascending. Ids are `<seriesId>-c<number>` so progress on an AniList page
 * survives; chapters without a number go last with a hashed id.
 *
 * Sources whose numbering restarts each volume (vol. 1 ch. 1, vol. 2 ch. 1…) are detected (one
 * number seen in two different volumes): their chapters are then told apart by volume too, sorted
 * by volume, and the repeats get `<seriesId>-v<volume>-c<number>` (the first occurrence keeps the
 * plain id, so existing progress stays).
 */
export function buildChapters(seriesId: string, all: ExtChapter[], lang: string): StoredChapter[] {
  const inLang = all.filter((c) => c.lang === lang);
  const volumesOf = new Map<string, Set<number>>();
  for (const c of inLang) {
    if (!Number.isFinite(c.number) || c.number < 0 || c.volume == null) continue;
    const k = numKey(c.number);
    if (!volumesOf.has(k)) volumesOf.set(k, new Set());
    volumesOf.get(k)!.add(c.volume);
  }
  const restarts = [...volumesOf.values()].some((v) => v.size > 1);

  const byKey = new Map<string, ExtChapter>();
  const unnumbered: ExtChapter[] = [];
  for (const c of inLang) {
    if (!Number.isFinite(c.number) || c.number < 0) unnumbered.push(c);
    else {
      // Without a volume, a group's copy merges with the volume-tagged one of the same number.
      const vol = restarts && c.volume != null ? c.volume : restarts ? ([...(volumesOf.get(numKey(c.number)) ?? [])].sort((a, b) => a - b)[0] ?? '') : '';
      const k = `${vol}|${numKey(c.number)}`;
      if (!byKey.has(k)) byKey.set(k, c);
    }
  }
  const numbered = [...byKey.values()].sort((a, b) =>
    restarts ? (a.volume ?? 0) - (b.volume ?? 0) || a.number - b.number : a.number - b.number || (a.volume ?? 0) - (b.volume ?? 0),
  );
  const last = numbered.reduce((m, c) => Math.max(m, c.number), 0);
  const extra = unnumbered.sort((a, b) => (a.sortingIndex ?? 0) - (b.sortingIndex ?? 0));
  const taken = new Set<string>();
  return [
    ...numbered.map((c) => {
      const plain = `${seriesId}-c${numKey(c.number)}`;
      const id = taken.has(plain) ? `${seriesId}-v${c.volume ?? 0}-c${numKey(c.number)}` : plain;
      taken.add(plain);
      if (!restarts || c.volume == null) return { ...c, id };
      return { ...c, id, title: `Vol. ${c.volume}${c.title ? ` — ${c.title}` : ''}` };
    }),
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
