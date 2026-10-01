/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import AsyncStorage from '@react-native-async-storage/async-storage';

import { buildOffsetIndex, mappingFrom } from '../episode-map';
import { imdbIds, requestsFor } from '../id-candidates';
import { withEpisodeMapping, type AnimeIds } from '../ids';
import type { Manifest } from '../protocol';

// Excerpts of the Fribb anime-lists mapping (anime-lists-reduced.json).
const FRIBB = [
  { anidb_id: 17061, season: { tvdb: 1, tmdb: 1 }, episode_offset: { tvdb: 12, tmdb: 12 } }, // Spy x Family Part 2
  { anidb_id: 16177, season: { tvdb: 4, tmdb: 4 }, episode_offset: { tvdb: 16, tmdb: 16 } }, // AoT Final Season Part 2
  { anidb_id: 19242, season: { tvdb: 4, tmdb: 1 }, episode_offset: { tmdb: 66 } }, // Re:Zero S4
  { anidb_id: 17196, season: { tvdb: 2, tmdb: 2 } }, // Jujutsu Kaisen S2: no offset
];

const aio: Manifest = {
  id: 'aio', name: 'AIOStreams', types: ['movie', 'series', 'anime'],
  resources: [{ name: 'stream', types: ['movie', 'series', 'anime'], idPrefixes: ['tt', 'kitsu', 'anilist', 'mal'] }],
};
const torrentio: Manifest = {
  id: 'torrentio', name: 'Torrentio', types: ['movie', 'series'],
  resources: [{ name: 'stream', types: ['movie', 'series', 'anime'], idPrefixes: ['tt', 'kitsu'] }],
};
const animeOnly: Manifest = {
  id: 'anime', name: 'Anime', types: ['series', 'anime'],
  resources: [{ name: 'stream', types: ['series', 'anime'], idPrefixes: ['kitsu', 'anilist'] }],
};
const noPrefixes: Manifest = { id: 'plain', name: 'Plain', types: ['series'], resources: ['stream'] };

test('the offset index keeps only entries with an episode offset', () => {
  const idx = buildOffsetIndex(FRIBB);
  assert.deepEqual(Object.keys(idx).sort(), ['16177', '17061', '19242']);
  assert.deepEqual(mappingFrom(idx, 17061), { tvdbSeason: 1, tvdbOffset: 12, tmdbSeason: 1, tmdbOffset: 12 });
  assert.deepEqual(mappingFrom(idx, 19242), { tvdbSeason: 4, tvdbOffset: undefined, tmdbSeason: 1, tmdbOffset: 66 });
  assert.equal(mappingFrom(idx, 17196), null);
  assert.equal(mappingFrom(idx, undefined), null);
});

test('IMDb ids follow TheTVDB numbering of split-cour parts', () => {
  const spy: AnimeIds = { anilist: 142838, imdb: 'tt13706018', season: 1, epOffset: 12 };
  assert.deepEqual(imdbIds(spy, 1), ['tt13706018:1:13']);
  const aot: AnimeIds = { anilist: 131681, imdb: 'tt2560140', season: 4, epOffset: 16 };
  assert.deepEqual(imdbIds(aot, 1), ['tt2560140:4:17']);
  // TMDB numbering as a second guess when it differs.
  const rezero: AnimeIds = { anilist: 189046, imdb: 'tt5607616', season: 4, alt: { season: 1, offset: 66 } };
  assert.deepEqual(imdbIds(rezero, 1), ['tt5607616:4:1', 'tt5607616:1:67']);
  // No mapping: season from ARM, episode as is; movies: the bare id.
  assert.deepEqual(imdbIds({ anilist: 1, imdb: 'tt1', season: 2 }, 3), ['tt1:2:3']);
  assert.deepEqual(imdbIds({ anilist: 1, imdb: 'tt1', media: 'MOVIE' }, 1), ['tt1']);
  assert.deepEqual(imdbIds({ anilist: 1 }, 1), []);
});

test('withEpisodeMapping applies the Fribb offsets to the ARM ids', async () => {
  await AsyncStorage.setItem('huwa/episode-offsets/v1', JSON.stringify({ at: Date.now(), index: buildOffsetIndex(FRIBB) }));
  const spy = await withEpisodeMapping({ anilist: 142838, anidb: 17061, kitsu: 45619, imdb: 'tt13706018', season: 1, media: 'TV' });
  assert.equal(spy?.epOffset, 12);
  assert.equal(spy?.alt, undefined, 'same numbering on TMDB: no second guess');
  const rezero = await withEpisodeMapping({ anilist: 189046, anidb: 19242, imdb: 'tt5607616', season: 4, media: 'TV' });
  assert.equal(rezero?.season, 4);
  assert.equal(rezero?.epOffset, undefined);
  assert.deepEqual(rezero?.alt, { season: 1, offset: 66 });
  const jjk = await withEpisodeMapping({ anilist: 145064, anidb: 17196, imdb: 'tt12343534', season: 2 });
  assert.equal(jjk?.epOffset, undefined);
  assert.equal(await withEpisodeMapping(null), null);
});

test('aggregators get IMDb second (asked in parallel with the first), alternative numbering last', () => {
  const ids: AnimeIds = { anilist: 142838, kitsu: 45619, mal: 50602, imdb: 'tt13706018', season: 1, epOffset: 12, alt: { season: 1, offset: 0 } };
  assert.deepEqual(requestsFor(aio, 'stream', 'al142838', 1, ids).map((r) => r.id), [
    'anilist:142838:1', 'tt13706018:1:13', 'kitsu:45619:1', 'mal:50602:1', 'tt13706018:1:1',
  ]);
  assert.deepEqual(requestsFor(torrentio, 'stream', 'al142838', 1, ids).map((r) => r.id), ['kitsu:45619:1', 'tt13706018:1:13', 'tt13706018:1:1']);
  assert.deepEqual(requestsFor(animeOnly, 'stream', 'al142838', 1, ids).map((r) => r.id), ['anilist:142838:1', 'kitsu:45619:1']);
  assert.deepEqual(requestsFor(noPrefixes, 'stream', 'al142838', 1, ids).map((r) => r.id), [
    'tt13706018:1:13', 'kitsu:45619:1', 'anilist:142838:1', 'tt13706018:1:1',
  ]);
  assert.ok(requestsFor(aio, 'stream', 'al142838', 1, ids).every((r) => r.type === 'series'));
});

test('movies use bare ids and the movie type', () => {
  const ids: AnimeIds = { anilist: 199, kitsu: 176, imdb: 'tt0245429', media: 'MOVIE' };
  const reqs = requestsFor(torrentio, 'stream', 'al199', 1, ids);
  assert.deepEqual(reqs, [{ type: 'movie', id: 'kitsu:176' }, { type: 'movie', id: 'tt0245429' }]);
});
