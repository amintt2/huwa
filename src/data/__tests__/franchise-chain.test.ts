/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Media } from '../anilist';
import { franchiseChain, isSeasonEntry, MAX_HOPS, prequelOf, sequelOf, specialRelationsOf, walkRelation } from '../anilist-relations';

type Node = {
  format?: string;
  type?: 'ANIME' | 'MANGA';
  episodes?: number | null;
  status?: Media['status'];
  prequel?: number[];
  sequel?: number[];
  side?: number[];
};

/** A fake AniList: id → entry, relations resolved on fetch (like the real nested `relations`). */
function anilist(graph: Record<number, Node>) {
  const fetched: number[] = [];
  const bare = (id: number): Media => ({
    id,
    type: graph[id]?.type ?? 'ANIME',
    format: graph[id]?.format ?? 'TV',
    status: graph[id]?.status ?? 'FINISHED',
    countryOfOrigin: 'JP',
    episodes: graph[id]?.episodes === undefined ? 12 : graph[id]?.episodes,
    chapters: null,
    averageScore: null,
    genres: [],
    seasonYear: 2020,
    title: { english: `#${id}`, userPreferred: `#${id}` },
    description: null,
    coverImage: { extraLarge: null, color: null },
    bannerImage: null,
    nextAiringEpisode: null,
  } as unknown as Media);
  const fetch = async (id: number): Promise<Media> => {
    fetched.push(id);
    const n = graph[id];
    if (!n) throw new Error(`404 ${id}`);
    const edges = [
      ...(n.prequel ?? []).map((p) => ({ relationType: 'PREQUEL', node: bare(p) })),
      ...(n.sequel ?? []).map((p) => ({ relationType: 'SEQUEL', node: bare(p) })),
      ...(n.side ?? []).map((p) => ({ relationType: 'SIDE_STORY', node: bare(p) })),
    ];
    return { ...bare(id), relations: { edges } };
  };
  return { fetch, fetched };
}

const ids = (list: Media[]) => list.map((m) => m.id);

/** 1 → 2 → 3 → 4, a plain four-season show. */
const linear: Record<number, Node> = {
  1: { sequel: [2] },
  2: { prequel: [1], sequel: [3] },
  3: { prequel: [2], sequel: [4] },
  4: { prequel: [3] },
};

test('prequels first season first, then the series, then the sequels in order', async () => {
  const { fetch } = anilist(linear);
  const c = await franchiseChain(3, fetch);
  assert.equal(c.ok, true);
  assert.deepEqual(ids(c.before), [1, 2]);
  assert.equal(c.self?.id, 3);
  assert.deepEqual(ids(c.after), [4]);
});

test('first and last season: one side is empty', async () => {
  const a = await franchiseChain(1, anilist(linear).fetch);
  assert.deepEqual([ids(a.before), ids(a.after)], [[], [2, 3, 4]]);
  const b = await franchiseChain(4, anilist(linear).fetch);
  assert.deepEqual([ids(b.before), ids(b.after)], [[1, 2, 3], []]);
});

test('known prequels: only the sequels are walked', async () => {
  const { fetch, fetched } = anilist(linear);
  const c = await franchiseChain(3, fetch, { prequels: false });
  assert.deepEqual(ids(c.before), []);
  assert.deepEqual(ids(c.after), [4]);
  assert.deepEqual(fetched, [3, 4], 'no request for seasons 1 and 2');
});

test('movies and specials are walked through but not listed; TV seasons are preferred', async () => {
  const { fetch } = anilist({
    1: { sequel: [10, 2] }, // a movie and season 2 both follow season 1: season 2 wins
    10: { format: 'MOVIE', prequel: [1] },
    2: { prequel: [1], sequel: [20] },
    20: { format: 'MOVIE', prequel: [2], sequel: [3] }, // the only way to season 3 goes through a movie
    3: { format: 'ONA', prequel: [20] },
  });
  const c = await franchiseChain(1, fetch);
  assert.deepEqual(ids(c.after), [2, 3]);
  const back = await franchiseChain(3, fetch);
  assert.deepEqual(ids(back.before), [1, 2]);
});

test('manga relations are ignored', async () => {
  const { fetch } = anilist({ 1: { sequel: [2] }, 2: { type: 'MANGA', prequel: [1] } });
  assert.equal(sequelOf(await fetch(1)), undefined);
  const c = await franchiseChain(1, fetch);
  assert.deepEqual([ids(c.before), ids(c.after)], [[], []]);
});

test('cycles stop the walk without repeating a season', async () => {
  const { fetch, fetched } = anilist({
    1: { prequel: [3], sequel: [2] },
    2: { prequel: [1], sequel: [3] },
    3: { prequel: [2], sequel: [1] },
  });
  const c = await franchiseChain(2, fetch);
  assert.equal(c.ok, true);
  const all = [...ids(c.before), c.self!.id, ...ids(c.after)];
  assert.equal(new Set(all).size, all.length, `no duplicate in ${all}`);
  assert.deepEqual(ids(c.before), [3, 1]);
  assert.deepEqual(ids(c.after), [], 'season 3 was already reached backwards');
  assert.ok(fetched.length <= 3);
});

test('a self-referencing entry ends right away', async () => {
  const c = await franchiseChain(1, anilist({ 1: { prequel: [1], sequel: [1] } }).fetch);
  assert.deepEqual([ids(c.before), c.self?.id, ids(c.after)], [[], 1, []]);
});

test('MAX_HOPS bounds each direction', async () => {
  const graph: Record<number, Node> = {};
  for (let i = 1; i <= 40; i++) graph[i] = { prequel: i > 1 ? [i - 1] : [], sequel: i < 40 ? [i + 1] : [] };
  const { fetch, fetched } = anilist(graph);
  const c = await franchiseChain(20, fetch);
  assert.equal(c.before.length, MAX_HOPS);
  assert.equal(c.after.length, MAX_HOPS);
  assert.deepEqual(ids(c.before), [12, 13, 14, 15, 16, 17, 18, 19]);
  assert.deepEqual(ids(c.after), [21, 22, 23, 24, 25, 26, 27, 28]);
  assert.equal(fetched.length, 1 + 2 * MAX_HOPS);
  const short = await franchiseChain(20, fetch, { maxHops: 2 });
  assert.deepEqual([ids(short.before), ids(short.after)], [[18, 19], [21, 22]]);
});

test('a failed request falls back to nothing (never rejects)', async () => {
  // Season 3 is missing: the walk fails halfway through the sequels.
  const { fetch } = anilist({ 1: { sequel: [2] }, 2: { prequel: [1], sequel: [3] } });
  const c = await franchiseChain(1, fetch);
  assert.deepEqual(c, { before: [], self: null, after: [], skipped: [], ok: false });
  const offline = await franchiseChain(1, async () => {
    throw new Error('offline');
  });
  assert.equal(offline.ok, false);
});

test('walkRelation: nearest first, shared `seen` set', async () => {
  const { fetch } = anilist(linear);
  const seen = new Set([4]);
  const back = await walkRelation(3, prequelOf, fetch, seen);
  assert.deepEqual(ids(back), [3, 2, 1]);
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4]);
  assert.deepEqual(await walkRelation(null, sequelOf, fetch, new Set()), []);
});

// ---------- what counts as a season ----------

const media = (format: string | null, episodes: number | null, status: Media['status'] = 'FINISHED') =>
  ({ type: 'ANIME', format, episodes, status }) as Pick<Media, 'type' | 'format' | 'episodes' | 'status'>;

test('season filter: TV always, TV_SHORT / ONA from 4 episodes (or still airing with no count)', () => {
  assert.equal(isSeasonEntry(media('TV', 1)), true, 'TV format counts whatever its length');
  assert.equal(isSeasonEntry(media('TV', null, 'RELEASING')), true);
  assert.equal(isSeasonEntry(media(null, null, 'NOT_YET_RELEASED')), true, 'unknown format = TV');
  assert.equal(isSeasonEntry(media('ONA', 1)), false, 'one-shot ONA');
  assert.equal(isSeasonEntry(media('ONA', 3)), false);
  assert.equal(isSeasonEntry(media('ONA', 4)), true);
  assert.equal(isSeasonEntry(media('TV_SHORT', 12)), true);
  assert.equal(isSeasonEntry(media('TV_SHORT', 2)), false);
  assert.equal(isSeasonEntry(media('ONA', null, 'RELEASING')), true);
  assert.equal(isSeasonEntry(media('ONA', null, 'NOT_YET_RELEASED')), true);
  assert.equal(isSeasonEntry(media('ONA', null, 'FINISHED')), false);
  for (const f of ['MOVIE', 'OVA', 'SPECIAL', 'MUSIC']) assert.equal(isSeasonEntry(media(f, 12)), false, f);
  assert.equal(isSeasonEntry({ ...media('TV', 12), type: 'MANGA' }), false);
});

test('One Piece: the 1-episode "MONSTERS" ONA prequel is walked through, not "Saison 1"', async () => {
  // AniList 21 (TV, releasing, no episode count) has a PREQUEL: 167404, a 1-episode ONA.
  const { fetch } = anilist({
    21: { format: 'TV', episodes: null, status: 'RELEASING', prequel: [167404], side: [459, 15323] },
    167404: { format: 'ONA', episodes: 1, sequel: [21] },
    459: { format: 'MOVIE', episodes: 1 },
    15323: { format: 'SPECIAL', episodes: 1 },
  });
  const c = await franchiseChain(21, fetch);
  assert.equal(c.ok, true);
  assert.deepEqual([ids(c.before), c.self?.id, ids(c.after)], [[], 21, []]);
  assert.deepEqual(ids(c.skipped), [167404], 'listed under "Spéciaux" instead');
  assert.deepEqual(ids(specialRelationsOf(c.self!)), [167404, 459, 15323]);
});

test('a short ONA between two seasons does not hide the season', async () => {
  const { fetch } = anilist({
    1: { sequel: [2, 3] }, // a 2-episode ONA and season 2 both follow season 1
    2: { format: 'ONA', episodes: 2, prequel: [1] },
    3: { prequel: [1] },
  });
  assert.equal(sequelOf(await fetch(1))?.id, 3);
  const c = await franchiseChain(1, fetch);
  assert.deepEqual(ids(c.after), [3]);
});

test('specials: side stories and recaps, not spin-offs, unreleased or music entries', async () => {
  const self = {
    ...(await anilist({ 1: {} }).fetch(1)),
    relations: {
      edges: [
        ['SIDE_STORY', 10, 'MOVIE', 'FINISHED'],
        ['SUMMARY', 11, 'TV', 'FINISHED'],
        ['SPIN_OFF', 12, 'TV_SHORT', 'FINISHED'],
        ['ALTERNATIVE', 13, 'OVA', 'FINISHED'],
        ['CHARACTER', 14, 'SPECIAL', 'FINISHED'],
        ['SIDE_STORY', 15, 'MOVIE', 'NOT_YET_RELEASED'],
        ['SIDE_STORY', 16, 'MUSIC', 'FINISHED'],
        ['SEQUEL', 17, 'TV', 'FINISHED'],
        ['PREQUEL', 18, 'OVA', 'FINISHED'],
      ].map(([relationType, id, format, status]) => ({
        relationType: relationType as string,
        node: { id, type: 'ANIME', format, status, episodes: 1 } as unknown as Media,
      })),
    },
  } as Media;
  assert.deepEqual(ids(specialRelationsOf(self)), [10, 11, 18]);
});
