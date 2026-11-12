// Where to watch / read a series legally: the official services AniList lists for it
// (`externalLinks` of type STREAMING, e.g. Crunchyroll, Netflix, ADN for an anime; Webtoon, Piccoma,
// Delitoon for a manhwa) and, for some anime, a direct link per episode (`streamingEpisodes`).
// Pure helpers (unit-tested) + the fetch; the hook lives in data/use-official-links.ts.
import { gql } from './anilist-gql';

export type ExternalLink = {
  site: string;
  url: string;
  type: string | null;
  language: string | null;
  icon: string | null;
  color: string | null;
};

export type StreamingEpisode = { title: string | null; url: string | null; site: string | null; thumbnail?: string | null };

export type OfficialLinks = { links: ExternalLink[]; episodes: StreamingEpisode[] };

export type OfficialSite = { site: string; url: string; language: string | null; icon: string | null; color: string | null };

/** AniList's language names for the app languages. */
const LANG_NAME: Record<string, string> = { fr: 'French', en: 'English' };

const isWeb = (url: string) => /^https?:\/\//i.test(url);

/**
 * Official streaming / reading services, best first for the user: their language, then links with
 * no language (worldwide), then English, then the rest. One row per service.
 */
export function officialSites(links: readonly ExternalLink[], lang: string): OfficialSite[] {
  const mine = LANG_NAME[lang] ?? 'English';
  const rank = (l: ExternalLink) => (l.language === mine ? 0 : l.language == null ? 1 : l.language === 'English' ? 2 : 3);
  const best = new Map<string, ExternalLink>();
  for (const l of links) {
    if (l.type !== 'STREAMING' || !l.url || !isWeb(l.url) || !l.site) continue;
    const prev = best.get(l.site);
    if (!prev || rank(l) < rank(prev)) best.set(l.site, l);
  }
  return [...best.values()]
    .sort((a, b) => rank(a) - rank(b) || a.site.localeCompare(b.site))
    .map(({ site, url, language, icon, color }) => ({ site, url, language, icon, color }));
}

/** Direct link to one episode (`Episode 12 - Title`), when AniList has it. */
export function episodeLink(episodes: readonly StreamingEpisode[], n: number): { site: string; url: string; title?: string } | undefined {
  for (const e of episodes) {
    const m = /^\s*(?:episode|épisode|ep\.?)\s*(\d+)\s*(?:[-–:]\s*(.*))?$/i.exec(e.title ?? '');
    if (!m || Number(m[1]) !== n || !e.url || !isWeb(e.url) || !e.site) continue;
    return { site: e.site, url: e.url.replace(/^http:/i, 'https:'), title: m[2]?.trim() || undefined };
  }
  return undefined;
}

/** Language label shown next to a service, in French ("VF", "anglais"…), or nothing. */
export function languageLabel(language: string | null, lang: string): string | undefined {
  if (!language) return undefined;
  if (language === LANG_NAME[lang]) return undefined;
  const fr: Record<string, string> = {
    English: 'anglais', French: 'français', Japanese: 'japonais', Korean: 'coréen', German: 'allemand',
    Spanish: 'espagnol', Portuguese: 'portugais', Italian: 'italien', Thai: 'thaï', Chinese: 'chinois',
    Indonesian: 'indonésien', Vietnamese: 'vietnamien', Arabic: 'arabe', Turkish: 'turc', Russian: 'russe',
  };
  return lang === 'fr' ? (fr[language] ?? language) : language;
}

export async function fetchOfficialLinks(anilistId: number): Promise<OfficialLinks> {
  const data = await gql<{ Media: { externalLinks: ExternalLink[] | null; streamingEpisodes: StreamingEpisode[] | null } | null }>(
    `query ($id: Int) { Media(id: $id) { externalLinks { site url type language icon color } streamingEpisodes { title url site thumbnail } } }`,
    { id: anilistId },
  );
  return { links: data.Media?.externalLinks ?? [], episodes: data.Media?.streamingEpisodes ?? [] };
}
