// Manhwa browsing: filters → AniList GraphQL query, active-filter pills, and the same filters
// applied locally (demo mode / offline catalog). Pure: no React Native import, unit-tested.

export type Origin = 'KR' | 'CN' | 'JP';
export type BrowseSort = 'trending' | 'popularity' | 'score' | 'recent' | 'updated' | 'title';
export type BrowseStatus = 'RELEASING' | 'FINISHED' | 'HIATUS' | 'NOT_YET_RELEASED' | 'CANCELLED';

export type MangaFilters = {
  query: string;
  /** AniList genres (English ids), all required. */
  genres: string[];
  status: BrowseStatus | null;
  /** null = every origin. */
  origin: Origin | null;
  yearFrom: number | null;
  yearTo: number | null;
  /** Minimum score out of 10. */
  minScore: number | null;
  sort: BrowseSort;
};

export const DEFAULT_FILTERS: MangaFilters = {
  query: '',
  genres: [],
  status: null,
  origin: 'KR',
  yearFrom: null,
  yearTo: null,
  minScore: null,
  sort: 'trending',
};

export const GENRE_LABELS: Record<string, string> = {
  Action: 'Action',
  Adventure: 'Aventure',
  Comedy: 'Comédie',
  Drama: 'Drame',
  Ecchi: 'Ecchi',
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
export const GENRES = Object.keys(GENRE_LABELS);
export const genreLabel = (g: string) => GENRE_LABELS[g] ?? g;

export const STATUS_LABELS: Record<BrowseStatus, string> = {
  RELEASING: 'En cours',
  FINISHED: 'Terminé',
  HIATUS: 'En pause',
  NOT_YET_RELEASED: 'À venir',
  CANCELLED: 'Annulé',
};
export const ORIGIN_LABELS: Record<Origin, string> = { KR: 'Manhwa (Corée)', CN: 'Manhua (Chine)', JP: 'Manga (Japon)' };
export const SORT_LABELS: Record<BrowseSort, string> = {
  trending: 'Tendance',
  popularity: 'Popularité',
  score: 'Note',
  recent: 'Récents',
  updated: 'Mis à jour',
  title: 'A–Z',
};

const SORTS: Record<BrowseSort, string> = {
  trending: 'TRENDING_DESC',
  popularity: 'POPULARITY_DESC',
  score: 'SCORE_DESC',
  recent: 'START_DATE_DESC',
  updated: 'UPDATED_AT_DESC',
  title: 'TITLE_ROMAJI',
};

export const YEAR_MIN = 1990;

/** Number of active filters (search text and sort excluded) — the badge on "Filtres". */
export function activeCount(f: MangaFilters): number {
  return (
    f.genres.length +
    (f.status ? 1 : 0) +
    (f.origin !== DEFAULT_FILTERS.origin ? 1 : 0) +
    (f.yearFrom !== null || f.yearTo !== null ? 1 : 0) +
    (f.minScore !== null ? 1 : 0)
  );
}

export type Pill = { key: string; label: string };

/** Summary of the active filters, one removable pill each. */
export function filterPills(f: MangaFilters): Pill[] {
  const out: Pill[] = [];
  if (f.origin !== DEFAULT_FILTERS.origin) out.push({ key: 'origin', label: f.origin ? ORIGIN_LABELS[f.origin] : 'Toutes origines' });
  for (const g of f.genres) out.push({ key: `genre:${g}`, label: genreLabel(g) });
  if (f.status) out.push({ key: 'status', label: STATUS_LABELS[f.status] });
  if (f.yearFrom !== null || f.yearTo !== null) {
    const label =
      f.yearFrom !== null && f.yearTo !== null
        ? f.yearFrom === f.yearTo
          ? `${f.yearFrom}`
          : `${f.yearFrom}–${f.yearTo}`
        : f.yearFrom !== null
          ? `Depuis ${f.yearFrom}`
          : `Jusqu’à ${f.yearTo}`;
    out.push({ key: 'year', label });
  }
  if (f.minScore !== null) out.push({ key: 'score', label: `★ ${f.minScore}+` });
  return out;
}

export function removePill(f: MangaFilters, key: string): MangaFilters {
  if (key.startsWith('genre:')) return { ...f, genres: f.genres.filter((g) => `genre:${g}` !== key) };
  switch (key) {
    case 'origin':
      return { ...f, origin: DEFAULT_FILTERS.origin };
    case 'status':
      return { ...f, status: null };
    case 'year':
      return { ...f, yearFrom: null, yearTo: null };
    case 'score':
      return { ...f, minScore: null };
    default:
      return f;
  }
}

/** Filters cleared, search text and sort kept. */
export const resetFilters = (f: MangaFilters): MangaFilters => ({ ...DEFAULT_FILTERS, query: f.query, sort: f.sort });

/** Stable key of a filter set (cache key). */
export const filtersKey = (f: MangaFilters) =>
  JSON.stringify([f.query.trim().toLowerCase(), [...f.genres].sort(), f.status, f.origin, f.yearFrom, f.yearTo, f.minScore, f.sort]);

export type GqlRequest = { query: string; variables: Record<string, unknown> };

/**
 * One page of results. Only the filters that are set go into the query: AniList treats an
 * explicit `null` argument as "match null".
 */
export function buildBrowseQuery(f: MangaFilters, page: number, fields: string, perPage = 30): GqlRequest {
  const defs = ['$page: Int', '$perPage: Int', '$sort: [MediaSort]'];
  const args = ['type: MANGA', 'isAdult: false', 'format_not: NOVEL', 'sort: $sort'];
  const q = f.query.trim();
  const variables: Record<string, unknown> = { page, perPage, sort: q ? ['SEARCH_MATCH', SORTS[f.sort]] : [SORTS[f.sort]] };
  const add = (def: string, arg: string, name: string, value: unknown) => {
    defs.push(def);
    args.push(arg);
    variables[name] = value;
  };
  if (q) add('$search: String', 'search: $search', 'search', q.slice(0, 120));
  if (f.origin) add('$origin: CountryCode', 'countryOfOrigin: $origin', 'origin', f.origin);
  if (f.genres.length) add('$genres: [String]', 'genre_in: $genres', 'genres', f.genres);
  if (f.status) add('$status: MediaStatus', 'status: $status', 'status', f.status);
  if (f.yearFrom !== null) add('$from: FuzzyDateInt', 'startDate_greater: $from', 'from', f.yearFrom * 10000);
  if (f.yearTo !== null) add('$to: FuzzyDateInt', 'startDate_lesser: $to', 'to', (f.yearTo + 1) * 10000);
  if (f.minScore !== null) add('$score: Int', 'averageScore_greater: $score', 'score', Math.round(f.minScore * 10) - 1);
  // Sorting by score: drop entries rated by a handful of people.
  if (f.sort === 'score') args.push('popularity_greater: 1000');
  return {
    query: `query (${defs.join(', ')}) { Page(page: $page, perPage: $perPage) { pageInfo { hasNextPage } media(${args.join(', ')}) { ${fields} } } }`,
    variables,
  };
}

export type HomeSectionId = 'trending' | 'updated' | 'top' | 'popular' | 'fresh';
export const HOME_SECTIONS: { id: HomeSectionId; title: string; sort: BrowseSort }[] = [
  { id: 'trending', title: 'Tendances', sort: 'trending' },
  { id: 'updated', title: 'Récemment mis à jour', sort: 'updated' },
  { id: 'top', title: 'Mieux notés', sort: 'score' },
  { id: 'popular', title: 'Populaires', sort: 'popularity' },
  { id: 'fresh', title: 'Nouveautés', sort: 'recent' },
];

/** Every home section in one request (GraphQL aliases). `now` decides what "new" means. */
export function buildHomeQuery(origin: Origin | null, fields: string, now: Date, perPage = 15): GqlRequest {
  const base = ['type: MANGA', 'isAdult: false', 'format_not: NOVEL', ...(origin ? [`countryOfOrigin: ${origin}`] : [])].join(', ');
  const yearAgo = (now.getFullYear() - 1) * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  const block = (alias: HomeSectionId, extra: string) => `${alias}: Page(perPage: ${perPage}) { media(${base}, ${extra}) { ${fields} } }`;
  return {
    query: `query { ${[
      block('trending', 'sort: [TRENDING_DESC]'),
      block('updated', 'status: RELEASING, sort: [UPDATED_AT_DESC]'),
      block('top', 'popularity_greater: 5000, sort: [SCORE_DESC]'),
      block('popular', 'sort: [POPULARITY_DESC]'),
      block('fresh', `startDate_greater: ${yearAgo}, sort: [POPULARITY_DESC]`),
    ].join('\n')} }`,
    variables: {},
  };
}

/** What local filtering needs from a series. */
export type Filterable = {
  title: string;
  genres: string[];
  year: number;
  rating: number;
  status: 'ongoing' | 'completed' | 'upcoming';
  trendRank?: number;
  origin?: Origin;
};

const STATUS_LOCAL: Partial<Record<BrowseStatus, Filterable['status']>> = { RELEASING: 'ongoing', FINISHED: 'completed', NOT_YET_RELEASED: 'upcoming' };

/** Same filters on an in-memory list (demo mode, offline): best effort, same semantics. */
export function filterLocal<T extends Filterable>(list: T[], f: MangaFilters): T[] {
  const q = f.query.trim().toLowerCase();
  const out = list.filter((s) => {
    if (q && !s.title.toLowerCase().includes(q)) return false;
    if (f.origin && s.origin && s.origin !== f.origin) return false;
    if (f.genres.length && !f.genres.every((g) => s.genres.includes(g) || s.genres.includes(genreLabel(g)))) return false;
    if (f.status && STATUS_LOCAL[f.status] !== s.status) return false;
    if (f.yearFrom !== null && !(s.year >= f.yearFrom)) return false;
    if (f.yearTo !== null && !(s.year > 0 && s.year <= f.yearTo)) return false;
    if (f.minScore !== null && !(s.rating >= f.minScore)) return false;
    return true;
  });
  const by: Record<BrowseSort, (a: T, b: T) => number> = {
    trending: (a, b) => (a.trendRank ?? 999) - (b.trendRank ?? 999),
    popularity: (a, b) => (a.trendRank ?? 999) - (b.trendRank ?? 999),
    score: (a, b) => b.rating - a.rating,
    recent: (a, b) => b.year - a.year,
    updated: (a, b) => b.year - a.year,
    title: (a, b) => a.title.localeCompare(b.title, 'fr'),
  };
  return out.sort(by[f.sort]);
}
