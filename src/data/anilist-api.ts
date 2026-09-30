// AniList queries beyond the trending catalog: live search, airing calendar, single series,
// next airings (notifications) and user lists (sync). Public API, no key needed
// (https://docs.anilist.co). Rate limit is ~30–90 req/min, so callers debounce.
import { build, ENDPOINT, episodeCount, isManhwa, NODE, type Media } from './anilist';
import { getSeries, registerSeries, type Series } from './catalog';

export class AniListError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

export async function gql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  opts: { signal?: AbortSignal; token?: string } = {},
): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
    signal: opts.signal,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.errors) {
    throw new AniListError(json?.errors?.[0]?.message ?? `AniList ${res.status}`, res.status);
  }
  return json.data as T;
}

// ---------- search ----------

export type MediaStatus = 'RELEASING' | 'FINISHED' | 'NOT_YET_RELEASED' | 'HIATUS' | 'CANCELLED';
export type SearchSort = 'relevance' | 'popularity' | 'trending' | 'score' | 'recent';
export type SearchType = 'all' | 'anime' | 'manhwa';

export type SearchParams = {
  query: string;
  type: SearchType;
  genre: string | null;
  year: number | null;
  status: MediaStatus | null;
  sort: SearchSort;
};

/** Light result row; the full series is fetched (and registered) when opened. */
export type MediaSummary = {
  anilistId: number;
  type: 'ANIME' | 'MANGA';
  title: string;
  image?: string;
  color: string | null;
  year: number | null;
  status: MediaStatus | null;
  episodes: number | null;
  chapters: number | null;
  score: number | null;
  genres: string[];
  /** Anime announced but no episode aired yet (and nothing to read): can't be opened. */
  unavailable: boolean;
};

export const GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music',
  'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller',
] as const;

const LIGHT = `id type format status seasonYear startDate { year } episodes chapters averageScore genres
  title { english userPreferred } coverImage { large color } nextAiringEpisode { episode airingAt }`;

type LightMedia = {
  id: number;
  type: 'ANIME' | 'MANGA';
  status: MediaStatus | null;
  seasonYear: number | null;
  startDate: { year: number | null } | null;
  episodes: number | null;
  chapters: number | null;
  averageScore: number | null;
  genres: string[] | null;
  title: { english: string | null; userPreferred: string };
  coverImage: { large: string; color: string | null };
  nextAiringEpisode: { episode: number; airingAt: number } | null;
};

const SORTS: Record<SearchSort, string> = {
  relevance: 'SEARCH_MATCH',
  popularity: 'POPULARITY_DESC',
  trending: 'TRENDING_DESC',
  score: 'SCORE_DESC',
  recent: 'START_DATE_DESC',
};

function summarize(m: LightMedia): MediaSummary {
  const aired = m.episodes ?? (m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : 0);
  return {
    anilistId: m.id,
    type: m.type,
    title: m.title.english ?? m.title.userPreferred,
    image: m.coverImage.large,
    color: m.coverImage.color,
    year: m.seasonYear ?? m.startDate?.year ?? null,
    status: m.status,
    episodes: m.episodes,
    chapters: m.chapters,
    score: m.averageScore,
    genres: m.genres ?? [],
    unavailable: m.type === 'ANIME' && aired === 0,
  };
}

/**
 * One request for both formats. AniList treats an explicit `null` filter as "match null",
 * so only the filters that are set go into the query.
 */
export async function searchMedia(p: SearchParams, signal?: AbortSignal): Promise<MediaSummary[]> {
  const q = p.query.trim();
  const sort = p.sort === 'relevance' && !q ? 'POPULARITY_DESC' : SORTS[p.sort];
  const defs: string[] = ['$sort: [MediaSort]'];
  const args: string[] = ['sort: $sort', 'isAdult: false'];
  const vars: Record<string, unknown> = { sort: [sort] };
  if (q) {
    defs.push('$search: String');
    args.push('search: $search');
    vars.search = q;
  }
  if (p.genre) {
    defs.push('$genre: String');
    args.push('genre: $genre');
    vars.genre = p.genre;
  }
  if (p.status) {
    defs.push('$status: MediaStatus');
    args.push('status: $status');
    vars.status = p.status;
  }
  if (p.year) {
    defs.push('$start: FuzzyDateInt, $end: FuzzyDateInt');
    args.push('startDate_greater: $start, startDate_lesser: $end');
    vars.start = p.year * 10000;
    vars.end = (p.year + 1) * 10000;
  }
  const a = args.join(', ');
  const per = p.type === 'all' ? 20 : 36;
  const blocks = [
    p.type !== 'manhwa' && `anime: Page(perPage: ${per}) { media(type: ANIME, ${a}) { ${LIGHT} } }`,
    p.type !== 'anime' && `manhwa: Page(perPage: ${per}) { media(type: MANGA, countryOfOrigin: KR, ${a}) { ${LIGHT} } }`,
  ].filter(Boolean);
  const data = await gql<{ anime?: { media: LightMedia[] }; manhwa?: { media: LightMedia[] } }>(
    `query (${defs.join(', ')}) { ${blocks.join('\n')} }`,
    vars,
    { signal },
  );
  const an = (data.anime?.media ?? []).map(summarize);
  const mh = (data.manhwa?.media ?? []).map(summarize);
  // Interleave so "Tout" shows both formats near the top.
  const out: MediaSummary[] = [];
  for (let i = 0; i < Math.max(an.length, mh.length); i++) {
    if (an[i]) out.push(an[i]);
    if (mh[i]) out.push(mh[i]);
  }
  return out;
}

// ---------- full series (opened from search / calendar) ----------

const FULL = `${NODE} relations { edges { relationType(version: 2) node { ${NODE} } } }`;

/** Build a Series from a full media node, pairing the anime with its manhwa when AniList links them. */
export function seriesFromMedia(m: Media): Series | null {
  if (m.type === 'ANIME') {
    const src = m.relations?.edges.find((e) => e.relationType === 'SOURCE' && isManhwa(e.node))?.node ?? null;
    return build(m, src, 999);
  }
  if (!isManhwa(m)) return null;
  const adaptation =
    m.relations?.edges.find((e) => e.relationType === 'ADAPTATION' && e.node.type === 'ANIME' && episodeCount(e.node) > 0)
      ?.node ?? null;
  return build(adaptation, m, 999);
}

/** Route of a series' page. */
export const seriesHref = (s: Series) => (s.anime ? (`/anime/${s.id}` as const) : (`/manhwa/${s.id}` as const));

/**
 * Resolve an AniList media to a series page, fetching and registering it if needed.
 * Returns the route to push, or throws.
 */
export async function openMedia(anilistId: number, type: 'ANIME' | 'MANGA') {
  const known = getSeries(type === 'ANIME' ? `al${anilistId}` : `alm${anilistId}`);
  if (known) return seriesHref(known);
  const data = await gql<{ Media: Media }>(`query ($id: Int) { Media(id: $id) { ${FULL} } }`, { id: anilistId });
  const s = seriesFromMedia(data.Media);
  if (!s) throw new AniListError('unavailable');
  registerSeries([s]);
  return seriesHref(s);
}

// ---------- airing calendar ----------

export type AiringItem = {
  id: number;
  episode: number;
  airingAt: number;
  anilistId: number;
  title: string;
  image?: string;
  color: string | null;
  format: string | null;
};

/** Every non-adult episode airing between `from` and `to` (unix seconds), soonest first. */
export async function fetchAiring(from: number, to: number, signal?: AbortSignal): Promise<AiringItem[]> {
  const out: AiringItem[] = [];
  for (let page = 1; page <= 8; page++) {
    const data = await gql<{
      Page: {
        pageInfo: { hasNextPage: boolean };
        airingSchedules: {
          id: number;
          episode: number;
          airingAt: number;
          media: {
            id: number;
            isAdult: boolean;
            format: string | null;
            title: { english: string | null; userPreferred: string };
            coverImage: { large: string; color: string | null };
          } | null;
        }[];
      };
    }>(
      `query ($page: Int, $from: Int, $to: Int) { Page(page: $page, perPage: 50) {
        pageInfo { hasNextPage }
        airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
          id episode airingAt media { id isAdult format title { english userPreferred } coverImage { large color } } } } }`,
      { page, from, to },
      { signal },
    );
    for (const a of data.Page.airingSchedules) {
      if (!a.media || a.media.isAdult) continue;
      out.push({
        id: a.id,
        episode: a.episode,
        airingAt: a.airingAt,
        anilistId: a.media.id,
        title: a.media.title.english ?? a.media.title.userPreferred,
        image: a.media.coverImage.large,
        color: a.media.coverImage.color,
        format: a.media.format,
      });
    }
    if (!data.Page.pageInfo.hasNextPage) break;
  }
  return out;
}

// ---------- next airings (notifications) ----------

export type UpcomingEpisode = { anilistId: number; title: string; episode: number; airingAt: number };

/** Next (up to 3) episodes of the given anime, straight from AniList's schedule. */
export async function fetchUpcoming(anilistIds: number[]): Promise<UpcomingEpisode[]> {
  if (!anilistIds.length) return [];
  const out: UpcomingEpisode[] = [];
  for (let i = 0; i < anilistIds.length; i += 50) {
    const data = await gql<{
      Page: {
        media: {
          id: number;
          title: { english: string | null; userPreferred: string };
          airingSchedule: { nodes: { episode: number; airingAt: number }[] };
        }[];
      };
    }>(
      `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) {
        id title { english userPreferred } airingSchedule(notYetAired: true, perPage: 3) { nodes { episode airingAt } } } } }`,
      { ids: anilistIds.slice(i, i + 50) },
    );
    for (const m of data.Page.media) {
      for (const n of m.airingSchedule.nodes) {
        out.push({ anilistId: m.id, title: m.title.english ?? m.title.userPreferred, episode: n.episode, airingAt: n.airingAt });
      }
    }
  }
  return out;
}

// ---------- user lists (sync) ----------

export type ListStatus = 'CURRENT' | 'PLANNING' | 'COMPLETED' | 'DROPPED' | 'PAUSED' | 'REPEATING';
export type ImportedEntry = { series: Series; status: ListStatus };

const MAX_IMPORT = 200;
const PRIORITY: ListStatus[] = ['CURRENT', 'REPEATING', 'PLANNING', 'PAUSED', 'COMPLETED', 'DROPPED'];

/** Authenticated viewer (OAuth token) → their user name. */
export async function fetchViewer(token: string) {
  const data = await gql<{ Viewer: { id: number; name: string } }>('query { Viewer { id name } }', {}, { token });
  return data.Viewer;
}

/**
 * A user's anime + manhwa lists. Works without a token for public profiles;
 * with a token, private lists are readable too.
 */
export async function fetchUserList(userName: string, token?: string): Promise<ImportedEntry[]> {
  const q = (type: 'ANIME' | 'MANGA') =>
    gql<{ MediaListCollection: { lists: { entries: { status: ListStatus; media: Media }[] }[] } }>(
      `query ($name: String) { MediaListCollection(userName: $name, type: ${type}) {
        lists { entries { status media { ${NODE} } } } } }`,
      { name: userName },
      { token },
    );
  const [anime, manga] = await Promise.all([q('ANIME'), q('MANGA')]);
  const entries = [
    ...anime.MediaListCollection.lists.flatMap((l) => l.entries),
    ...manga.MediaListCollection.lists.flatMap((l) => l.entries).filter((e) => isManhwa(e.media)),
  ].sort((a, b) => PRIORITY.indexOf(a.status) - PRIORITY.indexOf(b.status));

  const seen = new Set<string>();
  const out: ImportedEntry[] = [];
  for (const e of entries) {
    if (out.length >= MAX_IMPORT) break;
    const s = e.media.type === 'ANIME' ? build(e.media, null, 999) : build(null, e.media, 999);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    // Keep the richer catalog version (anime paired with its manhwa) when we already have it.
    out.push({ series: getSeries(s.id) ?? s, status: e.status });
  }
  registerSeries(out.map((e) => e.series).filter((s) => !getSeries(s.id)));
  return out;
}
