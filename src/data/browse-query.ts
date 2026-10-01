// Anime catalog browsing: filters → AniList GraphQL query, active-filter pills, section presets,
// and the same filters applied to local series (demo mode / offline). Pure, unit-tested in
// __tests__/browse-query.test.ts. Fetching and caching live in ./browse.ts.

export type BrowseStatus = 'RELEASING' | 'FINISHED' | 'NOT_YET_RELEASED';
export type BrowseFormat = 'TV' | 'MOVIE' | 'ONA' | 'OVA' | 'SPECIAL' | 'TV_SHORT';
export type Season = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
export type BrowseSort = 'trending' | 'popularity' | 'score' | 'recent' | 'title';

export type BrowseFilters = {
  query: string;
  genres: string[];
  status: BrowseStatus | null;
  formats: BrowseFormat[];
  season: Season | null;
  year: number | null;
  /** On the 0–10 scale shown in the app (AniList averageScore / 10). */
  minScore: number | null;
  sort: BrowseSort;
  /** Hides obscure entries from score-sorted lists (AniList popularity = list count). */
  minPopularity?: number | null;
};

export const EMPTY_FILTERS: BrowseFilters = {
  query: '', genres: [], status: null, formats: [], season: null, year: null, minScore: null, sort: 'trending',
};

export const STATUS_LABEL: Record<BrowseStatus, string> = { RELEASING: 'En cours', FINISHED: 'Terminé', NOT_YET_RELEASED: 'À venir' };
export const FORMAT_LABEL: Record<BrowseFormat, string> = { TV: 'Série TV', MOVIE: 'Film', ONA: 'ONA', OVA: 'OVA', SPECIAL: 'Spécial', TV_SHORT: 'Format court' };
export const SEASON_LABEL: Record<Season, string> = { WINTER: 'Hiver', SPRING: 'Printemps', SUMMER: 'Été', FALL: 'Automne' };
export const SORT_LABEL: Record<BrowseSort, string> = { trending: 'Tendance', popularity: 'Popularité', score: 'Note', recent: 'Récents', title: 'A–Z' };
export const GENRE_LABEL: Record<string, string> = {
  Action: 'Action', Adventure: 'Aventure', Comedy: 'Comédie', Drama: 'Drame', Ecchi: 'Ecchi', Fantasy: 'Fantasy',
  Horror: 'Horreur', 'Mahou Shoujo': 'Magical girl', Mecha: 'Mecha', Music: 'Musique', Mystery: 'Mystère',
  Psychological: 'Psychologique', Romance: 'Romance', 'Sci-Fi': 'Science-fiction', 'Slice of Life': 'Tranche de vie',
  Sports: 'Sport', Supernatural: 'Surnaturel', Thriller: 'Thriller',
};
export const BROWSE_GENRES = Object.keys(GENRE_LABEL).filter((g) => g !== 'Ecchi');
export const SCORE_STEPS = [6, 7, 7.5, 8, 8.5];

const SORTS: Record<BrowseSort, string[]> = {
  trending: ['TRENDING_DESC', 'POPULARITY_DESC'],
  popularity: ['POPULARITY_DESC'],
  score: ['SCORE_DESC', 'POPULARITY_DESC'],
  recent: ['START_DATE_DESC', 'POPULARITY_DESC'],
  title: ['TITLE_ROMAJI'],
};

export const LIGHT_FIELDS = `id format status season seasonYear startDate { year } episodes averageScore popularity genres
  title { english userPreferred } coverImage { large color } nextAiringEpisode { episode airingAt }`;

/**
 * Query for one page of results. AniList treats an explicit `null` argument as "match null",
 * so only the filters that are set become arguments.
 */
export function buildBrowseQuery(f: BrowseFilters, page = 1, perPage = 30): { query: string; variables: Record<string, unknown> } {
  const defs = ['$page: Int', '$perPage: Int', '$sort: [MediaSort]'];
  const args = ['type: ANIME', 'isAdult: false', 'sort: $sort'];
  const q = f.query.trim();
  // Typing a title: best matches first, unless an explicit sort other than the default is chosen.
  const sort = q && f.sort === 'trending' ? ['SEARCH_MATCH'] : SORTS[f.sort];
  const variables: Record<string, unknown> = { page, perPage, sort };
  const add = (name: string, type: string, arg: string, value: unknown) => {
    defs.push(`$${name}: ${type}`);
    args.push(`${arg}: $${name}`);
    variables[name] = value;
  };
  if (q) add('search', 'String', 'search', q);
  if (f.genres.length) add('genres', '[String]', 'genre_in', f.genres);
  if (f.status) add('status', 'MediaStatus', 'status', f.status);
  if (f.formats.length) add('formats', '[MediaFormat]', 'format_in', f.formats);
  if (f.season) add('season', 'MediaSeason', 'season', f.season);
  if (f.year) add('year', 'Int', 'seasonYear', f.year);
  // "≥ 8.0" → averageScore > 79 (the API compares strictly).
  if (f.minScore != null) add('minScore', 'Int', 'averageScore_greater', Math.round(f.minScore * 10) - 1);
  if (f.minPopularity) add('minPop', 'Int', 'popularity_greater', f.minPopularity);
  // Upcoming titles have no score and nothing to watch: only shown when asked for.
  if (f.status !== 'NOT_YET_RELEASED' && f.sort !== 'recent') add('notStatus', 'MediaStatus', 'status_not', 'NOT_YET_RELEASED');
  return {
    query: `query (${defs.join(', ')}) { Page(page: $page, perPage: $perPage) { pageInfo { hasNextPage } media(${args.join(', ')}) { ${LIGHT_FIELDS} } } }`,
    variables,
  };
}

/** Latest aired episodes (one row per series, newest first). */
export function buildAiredQuery(page: number, nowSec: number, perPage = 50) {
  return {
    query: `query ($page: Int, $perPage: Int, $now: Int, $from: Int) { Page(page: $page, perPage: $perPage) { pageInfo { hasNextPage }
      airingSchedules(airingAt_lesser: $now, airingAt_greater: $from, sort: TIME_DESC) { episode airingAt media { isAdult ${LIGHT_FIELDS} } } } }`,
    variables: { page, perPage, now: nowSec, from: nowSec - 14 * 86400 },
  };
}

// ---------- season ----------

export function seasonOf(date: Date): { season: Season; year: number } {
  const m = date.getMonth();
  const season: Season = m < 3 ? 'WINTER' : m < 6 ? 'SPRING' : m < 9 ? 'SUMMER' : 'FALL';
  return { season, year: date.getFullYear() };
}

// ---------- sections of the Anime tab ----------

export type SectionId = 'trending' | 'top' | 'season' | 'recent' | 'upcoming';

export type SectionDef = { id: SectionId; title: string; subtitle?: string; filters: BrowseFilters; aired?: boolean };

export function sectionDefs(now: Date): SectionDef[] {
  const { season, year } = seasonOf(now);
  return [
    { id: 'trending', title: 'Tendances', filters: { ...EMPTY_FILTERS, sort: 'trending' } },
    { id: 'top', title: 'Mieux notés', subtitle: 'Note moyenne AniList', filters: { ...EMPTY_FILTERS, sort: 'score', minPopularity: 20000 } },
    { id: 'season', title: 'Populaires de la saison', subtitle: `${SEASON_LABEL[season]} ${year}`, filters: { ...EMPTY_FILTERS, sort: 'popularity', season, year } },
    { id: 'recent', title: 'Récemment sortis', subtitle: 'Derniers épisodes diffusés', filters: { ...EMPTY_FILTERS, sort: 'recent', status: 'RELEASING' }, aired: true },
    { id: 'upcoming', title: 'Bientôt', filters: { ...EMPTY_FILTERS, sort: 'popularity', status: 'NOT_YET_RELEASED' } },
  ];
}

// ---------- active filters ----------

export type Pill = { key: string; label: string };

export function activePills(f: BrowseFilters): Pill[] {
  const out: Pill[] = [];
  for (const g of f.genres) out.push({ key: `genre:${g}`, label: GENRE_LABEL[g] ?? g });
  if (f.status) out.push({ key: 'status', label: STATUS_LABEL[f.status] });
  for (const x of f.formats) out.push({ key: `format:${x}`, label: FORMAT_LABEL[x] });
  if (f.season || f.year) out.push({ key: 'season', label: [f.season && SEASON_LABEL[f.season], f.year].filter(Boolean).join(' ') });
  if (f.minScore != null) out.push({ key: 'score', label: `★ ${f.minScore.toFixed(1).replace('.', ',')}+` });
  if (f.sort !== 'trending') out.push({ key: 'sort', label: `Tri : ${SORT_LABEL[f.sort]}` });
  return out;
}

export function removePill(f: BrowseFilters, key: string): BrowseFilters {
  const [kind, value] = key.split(':');
  switch (kind) {
    case 'genre':
      return { ...f, genres: f.genres.filter((g) => g !== value) };
    case 'format':
      return { ...f, formats: f.formats.filter((x) => x !== value) };
    case 'status':
      return { ...f, status: null };
    case 'season':
      return { ...f, season: null, year: null };
    case 'score':
      return { ...f, minScore: null };
    case 'sort':
      return { ...f, sort: 'trending' };
    default:
      return f;
  }
}

/** Filters other than the search text are set (the tab then shows results instead of sections). */
export const hasFilters = (f: BrowseFilters) => activePills(f).length > 0;

export const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** Stable cache key of a filter set. */
export const filtersKey = (f: BrowseFilters) =>
  JSON.stringify([f.query.trim().toLowerCase(), [...f.genres].sort(), f.status, [...f.formats].sort(), f.season, f.year, f.minScore, f.sort, f.minPopularity ?? null]);

// ---------- local filtering (demo / offline catalog) ----------

export type LocalSeries = {
  id: string;
  title: string;
  genres: string[];
  year: number;
  /** 0–10. */
  rating: number;
  status: 'ongoing' | 'completed' | 'upcoming';
  trendRank?: number;
};

const LOCAL_STATUS: Record<LocalSeries['status'], BrowseStatus> = { ongoing: 'RELEASING', completed: 'FINISHED', upcoming: 'NOT_YET_RELEASED' };
// Local genre names may be French already ("Drame"): compare both spellings.
const genreMatch = (have: string[], want: string) => have.some((h) => h === want || h === GENRE_LABEL[want]);

export function filterLocal<T extends LocalSeries>(list: T[], f: BrowseFilters, now = new Date()): T[] {
  const q = f.query.trim().toLowerCase();
  const out = list.filter(
    (s) =>
      (!q || s.title.toLowerCase().includes(q)) &&
      f.genres.every((g) => genreMatch(s.genres, g)) &&
      (!f.status || LOCAL_STATUS[s.status] === f.status) &&
      (!f.year || s.year === f.year) &&
      // Local series have no season: a season filter keeps this year's series.
      (!f.season || f.year || s.year === now.getFullYear()) &&
      (f.minScore == null || s.rating >= f.minScore),
  );
  const by: Record<BrowseSort, (a: T, b: T) => number> = {
    trending: (a, b) => (a.trendRank ?? 999) - (b.trendRank ?? 999),
    popularity: (a, b) => (a.trendRank ?? 999) - (b.trendRank ?? 999),
    score: (a, b) => b.rating - a.rating,
    recent: (a, b) => b.year - a.year,
    title: (a, b) => a.title.localeCompare(b.title, 'fr'),
  };
  return out.sort(by[f.sort]);
}
