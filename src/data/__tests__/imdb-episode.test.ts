/// <reference types="node" />
// IMDb ids of absolute entries in the stream request path (data/imdb-episode.ts): the season
// model's verified numbering, loaded on demand from Cinemeta / anime-kitsu (fetch stubbed with
// listings shaped like the real ones, One Piece as of October 2026), without the anime page.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AnimeIds } from '../../addons/ids';
import { registerSeries, type Series } from '../catalog';
import { lazyImdbId, rememberRejected, verifiedSlot } from '../imdb-episode';

const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86400e3).toISOString();
const OP_SIZES = [8, 22, 17, 13, 9, 22, 39, 13, 52, 31, 99, 56, 100, 35, 62, 50, 118, 33, 98, 14, 194, 70, 25];
const START = '1999-10-20T00:00:00.000Z';

/** Cinemeta listing (590 in the specials, S0E39) and the anime-kitsu table (590 without a pair). */
function onePiece() {
  const videos: { season: number; episode: number; name: string; released: string }[] = [];
  const kitsu: { episode: number; imdbSeason?: number; imdbEpisode?: number; released: string }[] = [];
  let n = 0;
  OP_SIZES.forEach((size, i) => {
    let e = 0;
    for (let k = 0; k < size; k++) {
      n++;
      const released = addDays(START, 7 * (n - 1));
      if (n === 590) {
        videos.push({ season: 0, episode: 39, name: 'Dream 9 Toriko & One Piece & Dragon Ball Z (2/2)', released });
        kitsu.push({ episode: n, released });
        continue;
      }
      e++;
      videos.push({ season: i + 1, episode: e, name: `Title ${n}`, released });
      kitsu.push({ episode: n, imdbSeason: i + 1, imdbEpisode: e, released });
    }
  });
  return { videos, kitsu, total: n };
}

const op = onePiece();
const series = (id: string, count: number, title = 'ONE PIECE'): Series => ({
  id,
  title,
  synopsis: '',
  genres: [],
  year: 1999,
  rating: 8,
  palette: ['#000000', '#000000', '#000000'],
  author: '',
  status: 'ongoing',
  start: '1999-10-20',
  anime: {
    episodes: Array.from({ length: count }, (_, i) => ({
      id: `${id}-e${i + 1}`,
      seriesId: id,
      number: i + 1,
      title: '',
      durationMin: 24,
      chapters: [i + 1, i + 1] as const,
      videoUrl: '',
    })),
  },
});

let served: Record<string, unknown> = {};
let hang = false;
globalThis.fetch = (async (url: string) => {
  // Slow network: answers (404) only well after the resolver stopped waiting.
  if (hang) return new Promise((r) => setTimeout(() => r({ ok: false, status: 404, json: async () => ({}) }), 300));
  const body = served[String(url)];
  return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
}) as unknown as typeof fetch;

const OP_IDS: AnimeIds = { anilist: 21, kitsu: 12, imdb: 'tt0388629', media: 'TV' };

test('One Piece without the anime page: ep. 1000 = tt0388629:21:109, 590 has no IMDb id', async () => {
  assert.equal(op.total, 1180);
  served = {
    'https://v3-cinemeta.strem.io/meta/series/tt0388629.json': { meta: { videos: op.videos } },
    'https://anime-kitsu.strem.fun/meta/series/kitsu:12.json': { meta: { videos: op.kitsu } },
  };
  registerSeries([series('al21', 1180)]);
  const lazy = lazyImdbId('al21', 1000, OP_IDS);
  assert.equal(lazy.peek(), undefined, 'nothing known before the first request');
  assert.equal(await lazy.resolve(), 'tt0388629:21:109');
  assert.equal(lazy.peek(), 'tt0388629:21:109', 'known at once afterwards (stream cache, next episodes)');
  // TheTVDB put 590 in its specials (S0E39) and anime-kitsu gives it no pair: no IMDb request.
  assert.equal(await verifiedSlot('al21', 590, OP_IDS), null);
  assert.equal(await lazyImdbId('al21', 590, OP_IDS).resolve(), null);
  assert.deepEqual(await verifiedSlot('al21', 591, OP_IDS), { season: 16, episode: 12 });
  assert.deepEqual(await verifiedSlot('al21', 10, OP_IDS), { season: 2, episode: 2 }, 'not the "S1 E10" guess');
  // AniList one episode behind (1179 listed): the absolute listing lines up by chance (590 is in
  // the specials) and would say S21E110; the anime-kitsu table keeps 1000 = S21E109.
  registerSeries([series('al21', 1179)]);
  assert.equal(await lazyImdbId('al21', 1000, OP_IDS).resolve(), 'tt0388629:21:109');
  registerSeries([series('al21', 1180)]);
});

test('unverified numbering: no IMDb id past episode 26', async () => {
  // anime-kitsu table a week off from episode 600 on: refused, as is the shifted absolute listing.
  const shifted = op.kitsu.map((v) => (v.episode >= 600 ? { ...v, released: addDays(v.released, 7) } : v));
  served = {
    'https://v3-cinemeta.strem.io/meta/series/tt9000001.json': { meta: { videos: op.videos } },
    'https://anime-kitsu.strem.fun/meta/series/kitsu:9001.json': { meta: { videos: shifted } },
  };
  registerSeries([series('al9001', 1180, 'Shifted')]);
  const ids: AnimeIds = { anilist: 9001, kitsu: 9001, imdb: 'tt9000001', media: 'TV' };
  assert.equal(await verifiedSlot('al9001', 1000, ids), undefined);
  assert.equal(await lazyImdbId('al9001', 1000, ids).resolve(), null);
  // The anime page's franchise verdict wins (e.g. an IMDb id shared by several seasons).
  rememberRejected('al21', 'tt0388629', 1180);
  assert.equal(await lazyImdbId('al21', 1000, OP_IDS).resolve(), null);
});

test('Cinemeta too slow: the IMDb request goes out without the numbering, after a short wait', async () => {
  hang = true;
  registerSeries([series('al9002', 1180, 'Slow')]);
  const ids: AnimeIds = { anilist: 9002, kitsu: 9002, imdb: 'tt9000002', media: 'TV' };
  const t = Date.now();
  assert.equal(await verifiedSlot('al9002', 1000, ids, 50), undefined);
  assert.ok(Date.now() - t < 1000);
  hang = false;
});
