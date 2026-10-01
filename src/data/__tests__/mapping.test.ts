/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { animeEndChapter, animeStartChapter, approxEp, chapterAfterEpisode, continuationChapter, episodeForChapter } from '../bridge';
import { makeChapters, makeEpisodes, type Series } from '../catalog';
import { chainLayout, consistentPins, estimateCoverage, layoutSeason, spread, validateProposal, type Range } from '../mapping';
import { applyMapping, mappingRoom } from '../mapping-apply';

const monotonic = (ranges: readonly Range[]) =>
  ranges.every((r, i) => r[0] <= r[1] && (i === 0 || (r[0] >= ranges[i - 1][0] && r[1] >= ranges[i - 1][1])));

test('spread: even, contiguous, never backwards (even with fewer chapters than episodes)', () => {
  assert.deepEqual(spread(3, 0, 6), [[1, 2], [3, 4], [5, 6]]);
  assert.deepEqual(spread(2, 57, 60), [[58, 58], [59, 60]]);
  const tight = spread(5, 10, 13);
  assert.ok(monotonic(tight));
  assert.equal(tight[0][0], 11);
  assert.equal(tight[4][1], 13);
  assert.ok(monotonic(spread(4, 20, 20)));
});

test('chain: each season starts right after the previous seasons (estimates)', () => {
  const [s1, s2, s3] = chainLayout([
    { id: 's1', episodes: 12 },
    { id: 's2', episodes: 12 },
    { id: 's3', episodes: 13 },
  ]);
  assert.equal(s1.after, 0);
  assert.deepEqual(s1.ranges[0], [1, 2]);
  assert.equal(s1.end, estimateCoverage(12)); // 29
  assert.equal(s2.after, 29);
  assert.equal(s2.ranges[0][0], 30, 'season 2 does not restart at chapter 1');
  assert.equal(s2.end, 58);
  assert.equal(s3.ranges[0][0], 59);
  assert.equal(s3.end, 58 + estimateCoverage(13));
  for (const l of [s1, s2, s3]) {
    assert.equal(l.source, 'estimate');
    assert.ok(monotonic(l.ranges));
    assert.ok(l.exact.every((x) => !x));
  }
});

test('chain: exact provider data is kept and the next season follows it; known totals cap estimates', () => {
  const fixed = makeEpisodes('void', 24, 57).map((e) => e.chapters);
  const [s1, s2] = chainLayout([{ id: 'void', episodes: 24, fixed }, { id: 'void2', episodes: 12 }], 142);
  assert.equal(s1.source, 'source');
  assert.deepEqual(s1.ranges, fixed);
  assert.equal(s2.after, 57);
  assert.deepEqual(s2.ranges[0], [58, 59]);
  assert.equal(s2.end, 57 + estimateCoverage(12));

  // Manhwa of 70 chapters: the estimate leaves the last 5 for the continuation.
  const [a, b] = chainLayout([{ id: 'a', episodes: 24 }, { id: 'b', episodes: 24 }], 70);
  assert.equal(a.end, 58);
  assert.equal(b.end, 65);
  assert.ok(monotonic(b.ranges));
});

test('chain: a verified season end re-spreads its episodes and shifts the next seasons', () => {
  const [s1, s2] = chainLayout([
    { id: 's1', episodes: 12, override: { end: 40 } },
    { id: 's2', episodes: 12 },
  ]);
  assert.equal(s1.source, 'verified');
  assert.equal(s1.end, 40);
  assert.deepEqual(s1.ranges[0], [1, 3]);
  assert.ok(monotonic(s1.ranges));
  assert.ok(s1.exact.every((x) => !x), 'episodes stay approximate between verified bounds');
  assert.equal(s2.after, 40);
  assert.equal(s2.ranges[0][0], 41);

  // Estimated prequels that overshoot a verified end do not produce an empty season.
  const [, late] = chainLayout([{ id: 'x', episodes: 24 }, { id: 'y', episodes: 6, override: { end: 50 } }]);
  assert.equal(late.end, 50);
  assert.equal(late.ranges.length, 6);
  assert.ok(monotonic(late.ranges));
});

test('chain: pinned episodes are exact, the rest is interpolated around them', () => {
  const [s] = chainLayout([{ id: 's', episodes: 6, override: { end: 20, eps: { 3: [8, 9] } } }]);
  assert.deepEqual(s.ranges[2], [8, 9]);
  assert.deepEqual(s.exact, [false, false, true, false, false, false]);
  assert.equal(s.ranges[0][0], 1);
  assert.equal(s.ranges[1][1], 7);
  assert.equal(s.ranges[3][0], 10);
  assert.equal(s.ranges[5][1], 20);
  assert.ok(monotonic(s.ranges));

  // Episode 1 pinned: it fixes the season start.
  assert.deepEqual(layoutSeason(3, 29, 40, [[1, [31, 33]]])[0], [31, 33]);
  // Conflicting pins: the earliest wins, pins past the verified end are dropped.
  assert.deepEqual(
    consistentPins(6, { 2: [10, 12], 3: [5, 6], 4: [13, 14], 6: [40, 41] }, 30).map(([k]) => k),
    [2, 4],
  );
});

test('validateProposal: monotonic ranges, known chapter count, sane chapters per episode', () => {
  const ctx = { episodes: 12, after: 57, afterReliable: true, priorEpisodes: 24, knownTotal: 142 };
  assert.equal(validateProposal({ field: 'end', to: 88 }, ctx), null);
  assert.match(validateProposal({ field: 'end', to: 50 }, ctx)!, /précédentes/);
  assert.match(validateProposal({ field: 'end', to: 58 }, ctx)!, /Trop peu/);
  assert.match(validateProposal({ field: 'end', to: 143 }, ctx)!, /142/);
  assert.match(validateProposal({ field: 'end', to: 57 + 12 * 13 }, { ...ctx, knownTotal: undefined })!, /Trop de/);
  // Estimated start: checked against the whole franchise instead.
  assert.equal(validateProposal({ field: 'end', to: 50 }, { ...ctx, afterReliable: false }), null);
  assert.equal(validateProposal({ field: 'ep', ep: 1, from: 58, to: 60 }, ctx), null);
  assert.equal(validateProposal({ field: 'ep', ep: 1, from: 57, to: 58 }, ctx), null, 'may share the previous chapter');
  assert.match(validateProposal({ field: 'ep', ep: 13, from: 60, to: 61 }, ctx)!, /entre 1 et 12/);
  assert.match(validateProposal({ field: 'ep', ep: 2, from: 62, to: 60 }, ctx)!, /précéder/);
  assert.match(validateProposal({ field: 'ep', ep: 2, from: 60, to: 80 }, ctx)!, /au plus 12/);
  assert.match(validateProposal({ field: 'ep', ep: 2, from: 40, to: 41 }, ctx)!, /précédentes/);
});

// ---------- overlay on real Series objects ----------

const series = (id: string, eps: number, extra: Partial<Series> = {}): Series => ({
  id,
  title: id,
  synopsis: '',
  genres: [],
  year: 2024,
  rating: 8,
  palette: ['#000000', '#000000', '#000000'],
  author: '',
  status: 'ongoing',
  anime: { episodes: makeEpisodes(id, eps, Math.round(eps * 2.4), false) },
  ...extra,
});

test('overlay: later seasons continue after their prequels, with the same manhwa', () => {
  const manhwa = { chapters: makeChapters('al1', 200, false) };
  const s1 = series('al1', 12, { manhwa, manhwaId: 77, chaptersKnown: true, estimated: true });
  const s2 = series('al2', 12, { manhwa: { chapters: makeChapters('al2', 200, false) }, manhwaId: 77, chaptersKnown: true, estimated: true });
  const s3 = series('al3', 12, { estimated: false }); // no manhwa link on AniList
  const base = new Map([s1, s2, s3].map((s) => [s.id, s]));
  const get = (id: string) => base.get(id);
  const none = () => undefined;

  const v1 = applyMapping(s1, get, [], none);
  const v2 = applyMapping(s2, get, ['al1'], none);
  const v3 = applyMapping(s3, get, ['al1', 'al2'], none);

  assert.equal(animeStartChapter(v1), 1);
  assert.equal(animeEndChapter(v1), 29);
  assert.equal(animeStartChapter(v2), 30);
  assert.deepEqual(v2.anime!.episodes[0].chapters, [30, 31]);
  assert.equal(v2.mapping!.season, 1);
  assert.equal(v2.mapping!.after, 29);
  assert.equal(v2.mapping!.room, 'm77');
  assert.equal(continuationChapter(v2)!.number, 59);
  assert.equal(chapterAfterEpisode(v2, v2.anime!.episodes[0])!.number, 32);
  assert.equal(episodeForChapter(v2, 45)!.number, 7);

  // Season 3 inherits the manhwa of the previous seasons.
  assert.equal(v3.manhwa, s2.manhwa);
  assert.equal(v3.estimated, true);
  assert.equal(animeStartChapter(v3), 59);
  assert.equal(continuationChapter(v3)!.number, 88);
  assert.equal(mappingRoom(s2), 'm77');

  // Unknown prequels: the season is laid out alone (first-season view).
  assert.equal(animeStartChapter(applyMapping(s2, get, undefined, none)), 1);
});

test('overlay: verified values replace the estimate; cached until inputs change', () => {
  const manhwa = { chapters: makeChapters('al1', 150, false) };
  const s1 = series('al1', 12, { manhwa, manhwaId: 5, chaptersKnown: true, estimated: true });
  const s2 = series('al2', 12, { manhwa, manhwaId: 5, chaptersKnown: true, estimated: true });
  const base = new Map([s1, s2].map((s) => [s.id, s]));
  const get = (id: string) => base.get(id);
  const overrides: Record<string, { end?: number; eps?: Record<number, Range> }> = {};
  const overrideOf = (id: string) => overrides[id];

  const before = applyMapping(s2, get, ['al1'], overrideOf);
  assert.equal(applyMapping(s2, get, ['al1'], overrideOf), before, 'same inputs, same object');

  overrides.al1 = { end: 35 };
  overrides.al2 = { end: 70, eps: { 1: [36, 38] } };
  const after = applyMapping(s2, get, ['al1'], overrideOf);
  assert.notEqual(after, before);
  assert.equal(after.mapping!.source, 'verified');
  assert.equal(after.mapping!.afterReliable, true);
  assert.equal(after.estimated, false);
  assert.deepEqual(after.anime!.episodes[0].chapters, [36, 38]);
  assert.equal(after.anime!.episodes[0].estimated, false);
  assert.equal(approxEp(after, after.anime!.episodes[0]), '');
  assert.equal(approxEp(after, after.anime!.episodes[1]), '≈ ');
  assert.equal(animeEndChapter(after), 70);
  assert.equal(continuationChapter(after)!.number, 71);
});

test('overlay: exact demo data, placeholder chapter lists and series without anime', () => {
  const void1: Series = { ...series('void', 24), anime: { episodes: makeEpisodes('void', 24, 57) }, manhwa: { chapters: makeChapters('void', 142) } };
  const void2 = series('void2', 12, { estimated: true });
  const base = new Map([void1, void2].map((s) => [s.id, s]));
  const get = (id: string) => base.get(id);
  const v1 = applyMapping(void1, get, [], () => undefined);
  assert.equal(v1.mapping!.source, 'source');
  assert.deepEqual(v1.anime!.episodes.map((e) => e.chapters), void1.anime!.episodes.map((e) => e.chapters));
  assert.equal(v1.estimated, false);
  const v2 = applyMapping(void2, get, ['void'], () => undefined);
  assert.equal(v2.mapping!.room, 'void');
  assert.equal(v2.mapping!.afterReliable, true);
  assert.deepEqual(v2.anime!.episodes[0].chapters, [58, 59]);
  assert.equal(continuationChapter(v2)!.id, 'void-c87');

  // Placeholder list (AniList without a chapter count) grows past the anime.
  const short = series('al9', 24, { manhwa: { chapters: makeChapters('al9', 30, false) }, chaptersKnown: false, estimated: true });
  const v9 = applyMapping(short, () => undefined, [], () => undefined);
  assert.equal(animeEndChapter(v9), 58);
  assert.ok(v9.manhwa!.chapters.length > 58);
  assert.equal(v9.mapping!.knownTotal, undefined);

  const book: Series = { ...series('alm1', 0), anime: undefined, manhwa: { chapters: makeChapters('alm1', 10) } };
  assert.equal(applyMapping(book, () => undefined, [], () => undefined), book);
});
