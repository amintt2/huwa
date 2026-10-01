/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activePills,
  buildAiredQuery,
  buildBrowseQuery,
  EMPTY_FILTERS,
  filterLocal,
  filtersKey,
  hasFilters,
  removePill,
  sectionDefs,
  seasonOf,
  type BrowseFilters,
} from '../browse-query';

test('only set filters become query arguments', () => {
  const { query, variables } = buildBrowseQuery(EMPTY_FILTERS, 2, 20);
  assert.match(query, /type: ANIME, isAdult: false, sort: \$sort/);
  assert.doesNotMatch(query, /media\([^)]*(genre_in|format_in|seasonYear|averageScore_greater|search)/);
  assert.deepEqual(variables.sort, ['TRENDING_DESC', 'POPULARITY_DESC']);
  assert.equal(variables.page, 2);
  assert.equal(variables.notStatus, 'NOT_YET_RELEASED');
});

test('every filter maps to its AniList argument', () => {
  const f: BrowseFilters = {
    query: ' frieren ', genres: ['Fantasy', 'Drama'], status: 'FINISHED', formats: ['TV', 'MOVIE'],
    season: 'FALL', year: 2023, minScore: 8, sort: 'score', minPopularity: 1000,
  };
  const { query, variables } = buildBrowseQuery(f);
  for (const arg of ['search: $search', 'genre_in: $genres', 'status: $status', 'format_in: $formats', 'season: $season', 'seasonYear: $year', 'averageScore_greater: $minScore', 'popularity_greater: $minPop']) {
    assert.ok(query.includes(arg), arg);
  }
  assert.equal(variables.search, 'frieren');
  assert.equal(variables.minScore, 79);
  assert.deepEqual(variables.sort, ['SCORE_DESC', 'POPULARITY_DESC']);
  assert.deepEqual(variables.formats, ['TV', 'MOVIE']);
  // Typing with the default sort → relevance.
  assert.deepEqual(buildBrowseQuery({ ...EMPTY_FILTERS, query: 'x' }).variables.sort, ['SEARCH_MATCH']);
  // Asking for upcoming titles drops the "not upcoming" guard.
  assert.equal(buildBrowseQuery({ ...EMPTY_FILTERS, status: 'NOT_YET_RELEASED' }).variables.notStatus, undefined);
});

test('aired query covers the last two weeks', () => {
  const q = buildAiredQuery(1, 1_000_000);
  assert.match(q.query, /airingSchedules\(airingAt_lesser: \$now, airingAt_greater: \$from, sort: TIME_DESC\)/);
  assert.equal(q.variables.from, 1_000_000 - 14 * 86400);
});

test('season of a date and section presets', () => {
  assert.deepEqual(seasonOf(new Date(2026, 9, 1)), { season: 'FALL', year: 2026 });
  assert.deepEqual(seasonOf(new Date(2026, 0, 15)), { season: 'WINTER', year: 2026 });
  const defs = sectionDefs(new Date(2026, 3, 2));
  assert.deepEqual(defs.map((d) => d.id), ['trending', 'top', 'season', 'recent', 'upcoming']);
  assert.equal(defs[2].filters.season, 'SPRING');
  assert.equal(defs[2].subtitle, 'Printemps 2026');
});

test('pills list, remove and reset', () => {
  const f: BrowseFilters = { ...EMPTY_FILTERS, genres: ['Action', 'Romance'], formats: ['MOVIE'], minScore: 7.5, sort: 'title', season: 'SUMMER', year: 2025 };
  const pills = activePills(f);
  assert.deepEqual(pills.map((p) => p.label), ['Action', 'Romance', 'Film', 'Été 2025', '★ 7,5+', 'Tri : A–Z']);
  const g = removePill(f, 'genre:Action');
  assert.deepEqual(g.genres, ['Romance']);
  assert.equal(removePill(f, 'season').year, null);
  assert.equal(removePill(f, 'sort').sort, 'trending');
  assert.ok(hasFilters(f));
  assert.ok(!hasFilters({ ...EMPTY_FILTERS, query: 'abc' }));
  assert.equal(filtersKey({ ...f, genres: ['Romance', 'Action'] }), filtersKey(f));
});

test('local filtering for demo / offline', () => {
  const list = [
    { id: 'a', title: 'Zeta', genres: ['Action', 'Drame'], year: 2025, rating: 9.1, status: 'ongoing' as const, trendRank: 2 },
    { id: 'b', title: 'Alpha', genres: ['Romance'], year: 2023, rating: 7.2, status: 'completed' as const, trendRank: 1 },
    { id: 'c', title: 'Mid', genres: ['Action'], year: 2025, rating: 8.0, status: 'upcoming' as const },
  ];
  assert.deepEqual(filterLocal(list, EMPTY_FILTERS).map((s) => s.id), ['b', 'a', 'c']);
  assert.deepEqual(filterLocal(list, { ...EMPTY_FILTERS, genres: ['Drama'] }).map((s) => s.id), ['a']);
  assert.deepEqual(filterLocal(list, { ...EMPTY_FILTERS, minScore: 8, sort: 'score' }).map((s) => s.id), ['a', 'c']);
  assert.deepEqual(filterLocal(list, { ...EMPTY_FILTERS, status: 'FINISHED' }).map((s) => s.id), ['b']);
  assert.deepEqual(filterLocal(list, { ...EMPTY_FILTERS, sort: 'title' }).map((s) => s.id), ['b', 'c', 'a']);
  assert.deepEqual(filterLocal(list, { ...EMPTY_FILTERS, query: 'alp' }).map((s) => s.id), ['b']);
});
