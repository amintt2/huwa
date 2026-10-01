/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeCount,
  buildBrowseQuery,
  buildHomeQuery,
  DEFAULT_FILTERS,
  filterLocal,
  filterPills,
  filtersKey,
  removePill,
  resetFilters,
  type Filterable,
  type MangaFilters,
} from '../manhwa-filters';

const F = (p: Partial<MangaFilters>): MangaFilters => ({ ...DEFAULT_FILTERS, ...p });

test('default filters: manhwa only, trending, no null argument sent', () => {
  const { query, variables } = buildBrowseQuery(DEFAULT_FILTERS, 1, 'id');
  assert.match(query, /type: MANGA, isAdult: false, format_not: NOVEL, sort: \$sort/);
  assert.match(query, /countryOfOrigin: \$origin/);
  assert.doesNotMatch(query, /genre_in|status:|startDate|averageScore|search/);
  assert.deepEqual(variables, { page: 1, perPage: 30, sort: ['TRENDING_DESC'], origin: 'KR' });
});

test('every filter maps to its AniList argument', () => {
  const f = F({ query: ' solo ', genres: ['Action', 'Fantasy'], status: 'FINISHED', origin: null, yearFrom: 2015, yearTo: 2020, minScore: 8, sort: 'score' });
  const { query, variables } = buildBrowseQuery(f, 3, 'id title { english }', 24);
  assert.match(query, /search: \$search/);
  assert.match(query, /genre_in: \$genres/);
  assert.match(query, /status: \$status/);
  assert.match(query, /startDate_greater: \$from, startDate_lesser: \$to/);
  assert.match(query, /averageScore_greater: \$score/);
  assert.match(query, /popularity_greater: 1000/);
  assert.doesNotMatch(query, /countryOfOrigin/, 'all origins');
  assert.match(query, /\{ id title \{ english \} \}/);
  assert.deepEqual(variables, {
    page: 3,
    perPage: 24,
    sort: ['SEARCH_MATCH', 'SCORE_DESC'],
    search: 'solo',
    genres: ['Action', 'Fantasy'],
    status: 'FINISHED',
    from: 20150000,
    to: 20210000,
    score: 79,
  });
});

test('sorts', () => {
  const sortOf = (sort: MangaFilters['sort']) => buildBrowseQuery(F({ sort }), 1, 'id').variables.sort;
  assert.deepEqual(sortOf('popularity'), ['POPULARITY_DESC']);
  assert.deepEqual(sortOf('recent'), ['START_DATE_DESC']);
  assert.deepEqual(sortOf('updated'), ['UPDATED_AT_DESC']);
  assert.deepEqual(sortOf('title'), ['TITLE_ROMAJI']);
});

test('home query: five aliased sections, "new" relative to today', () => {
  const { query } = buildHomeQuery('KR', 'id', new Date(2026, 9, 1), 12);
  for (const alias of ['trending', 'updated', 'top', 'popular', 'fresh']) assert.match(query, new RegExp(`${alias}: Page\\(perPage: 12\\)`));
  assert.match(query, /countryOfOrigin: KR/);
  assert.match(query, /startDate_greater: 20251001/);
  assert.doesNotMatch(buildHomeQuery(null, 'id', new Date()).query, /countryOfOrigin/);
});

test('pills, count, removal and reset', () => {
  const f = F({ query: 'x', genres: ['Action', 'Romance'], status: 'RELEASING', origin: 'CN', yearFrom: 2020, minScore: 7, sort: 'score' });
  assert.equal(activeCount(f), 6);
  assert.deepEqual(filterPills(f).map((p) => p.label), ['Manhua (Chine)', 'Action', 'Romance', 'En cours', 'Depuis 2020', '★ 7+']);
  assert.deepEqual(removePill(f, 'genre:Action').genres, ['Romance']);
  assert.equal(removePill(f, 'origin').origin, 'KR');
  assert.equal(removePill(f, 'year').yearFrom, null);
  assert.equal(filterPills(F({ yearFrom: 2019, yearTo: 2019 }))[0].label, '2019');
  assert.equal(filterPills(F({ yearTo: 2010 }))[0].label, 'Jusqu’à 2010');
  assert.equal(filterPills(F({ origin: null }))[0].label, 'Toutes origines');
  const r = resetFilters(f);
  assert.equal(activeCount(r), 0);
  assert.equal(r.query, 'x', 'search text kept');
  assert.equal(r.sort, 'score', 'sort kept');
});

test('cache key ignores genre order and query case', () => {
  assert.equal(filtersKey(F({ genres: ['A', 'B'], query: 'Solo' })), filtersKey(F({ genres: ['B', 'A'], query: 'solo ' })));
  assert.notEqual(filtersKey(F({ sort: 'score' })), filtersKey(F({ sort: 'title' })));
});

test('local filtering (demo / offline) follows the same rules', () => {
  const list: (Filterable & { id: string })[] = [
    { id: 'a', title: 'Echo of the Void', genres: ['Action', 'Fantasy'], year: 2025, rating: 9.3, status: 'ongoing', trendRank: 2 },
    { id: 'b', title: 'Iron Lotus', genres: ['Mecha', 'Drame'], year: 2024, rating: 8.4, status: 'ongoing', trendRank: 1 },
    { id: 'c', title: 'Crimson Ledger', genres: ['Thriller'], year: 2023, rating: 8.9, status: 'completed', trendRank: 3 },
    { id: 'd', title: 'Night Garden', genres: ['Mystère'], year: 2024, rating: 8.9, status: 'ongoing', origin: 'CN' },
  ];
  const ids = (f: Partial<MangaFilters>) => filterLocal(list, F(f)).map((s) => s.id);
  assert.deepEqual(ids({}), ['b', 'a', 'c'], 'KR by default (unknown origin kept), trending order');
  assert.deepEqual(ids({ origin: null, sort: 'score' }), ['a', 'c', 'd', 'b']);
  assert.deepEqual(ids({ genres: ['Drama'] }), ['b'], 'English genre matches its French label');
  assert.deepEqual(ids({ status: 'FINISHED' }), ['c']);
  assert.deepEqual(ids({ yearFrom: 2024, yearTo: 2024 }), ['b']);
  assert.deepEqual(ids({ minScore: 9 }), ['a']);
  assert.deepEqual(ids({ query: 'lotus' }), ['b']);
  assert.deepEqual(ids({ sort: 'title' }), ['c', 'a', 'b']);
});
