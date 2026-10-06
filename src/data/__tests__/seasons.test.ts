/// <reference types="node" />
// Season model: grouping of AniList parts, TheTVDB numbering, absolute ↔ season mapping,
// mismatch fallbacks, sub-seasons of long-runners, specials. Fixtures follow the real data
// checked against AniList, ARM / Fribb and Cinemeta in October 2026.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  absoluteOf,
  chronologyLabel,
  chronologyName,
  compactVideos,
  composeSeasons,
  cumulativeRuns,
  episodeBadge,
  groupEntries,
  indexShow,
  infoOf,
  jstDate,
  pairOf,
  partOf,
  runsFromPairs,
  seasonDetail,
  seasonNumbers,
  seasonOf,
  shownNumber,
  sortSpecials,
  verifyRuns,
  type SeasonEntry,
  type ShowEpisode,
} from '../seasons';

const TODAY = '2026-10-06';
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86400e3).toISOString().slice(0, 10);

/** A show listing: `sizes[i]` episodes in season i+1, weekly from `start`, `skip` absolute numbers missing. */
function show(sizes: number[], start: string, { skip = [] as number[], specials = 0 } = {}) {
  const out: ShowEpisode[] = [];
  const real: Record<number, { s: number; e: number }> = {};
  let n = 0;
  let listed = 0;
  sizes.forEach((size, i) => {
    let e = 0;
    for (let k = 0; k < size; k++) {
      n++;
      if (skip.includes(n)) continue; // aired, but not in this season's listing (moved to specials)
      e++;
      out.push({ s: i + 1, e, title: `T${n}`, date: addDays(start, 7 * (n - 1)) });
      real[n] = { s: i + 1, e };
      listed++;
    }
  });
  for (let k = 1; k <= specials; k++) out.push({ s: 0, e: k, title: `SP${k}`, date: addDays(start, 30 * k) });
  return { eps: out.sort((a, b) => a.s - b.s || a.e - b.e), real, total: n, listed };
}

const entry = (id: string, title: string, episodes: number, map: SeasonEntry['map'], start?: string, ongoing = false): SeasonEntry => ({
  id,
  title,
  episodes,
  start,
  year: start ? Number(start.slice(0, 4)) : undefined,
  ongoing,
  map,
});

// ---------- small pieces ----------

test('Japan-time air dates', () => {
  assert.equal(jstDate('2020-12-06T15:30:00.000Z'), '2020-12-07', 'late-night slot = next day in Japan');
  assert.equal(jstDate('1999-10-20T00:00:00.000Z'), '1999-10-20');
  assert.equal(jstDate(undefined), undefined);
  assert.equal(jstDate('nope'), undefined);
});

test('Cinemeta videos compacted, placeholder titles dropped', () => {
  const eps = compactVideos([
    { season: 4, episode: 1, name: 'Episode 1' },
    { season: 1, episode: 2, name: 'Zoro', released: '1999-11-17T00:00:00.000Z' },
    { season: 1, episode: 1, name: "I'm Luffy!", released: '1999-10-20T00:00:00.000Z' },
    { episode: 3, name: 'no season' },
  ]);
  assert.deepEqual(eps, [
    { s: 1, e: 1, title: "I'm Luffy!", date: '1999-10-20' },
    { s: 1, e: 2, title: 'Zoro', date: '1999-11-17' },
    { s: 4, e: 1, title: undefined, date: undefined },
  ]);
});

test('part titles: "Part 2", "Cour 2", "2nd Part", Japanese halves', () => {
  assert.deepEqual(partOf('Attack on Titan Final Season Part 2'), { base: 'Attack on Titan Final Season', part: 2 });
  assert.deepEqual(partOf('Mushoku Tensei: Jobless Reincarnation Cour 2'), { base: 'Mushoku Tensei: Jobless Reincarnation', part: 2 });
  assert.deepEqual(partOf('Re:ZERO Season 2 Part II'), { base: 'Re:ZERO Season 2', part: 2 });
  assert.deepEqual(partOf('Vinland Saga 2nd Part'), { base: 'Vinland Saga', part: 2 });
  assert.deepEqual(partOf('Bleach: Sennen Kessen-hen - Partie 3'), { base: 'Bleach: Sennen Kessen-hen', part: 3 });
  assert.deepEqual(partOf('呪術廻戦 第2クール'), { base: '呪術廻戦', part: 2 });
  assert.deepEqual(partOf('Jujutsu Kaisen: Shimetsu Kaiyuu - Kouhen'), { base: 'Jujutsu Kaisen: Shimetsu Kaiyuu', part: 2 });
  assert.deepEqual(partOf('JUJUTSU KAISEN Season 3: The Culling Game Part 1'), { base: 'JUJUTSU KAISEN Season 3: The Culling Game', part: 1 });
  assert.deepEqual(partOf('SPY x FAMILY Season 2'), { base: 'SPY x FAMILY Season 2' });
  assert.deepEqual(partOf('Part 2'), { base: 'Part 2' }, 'a bare marker is a title, not a part');
});

// ---------- grouping and numbering ----------

const AOT = 'tt2560140';
const aot = [
  entry('al16498', 'Attack on Titan', 25, { imdb: AOT, season: 1 }, '2013-04-07'),
  entry('al20958', 'Attack on Titan Season 2', 12, { imdb: AOT, season: 2 }, '2017-04-01'),
  entry('al99147', 'Attack on Titan Season 3', 12, { imdb: AOT, season: 3 }, '2018-07-23'),
  entry('al104578', 'Attack on Titan Season 3 Part 2', 10, { imdb: AOT, season: 3, offset: 12 }, '2019-04-29'),
  entry('al110277', 'Attack on Titan Final Season', 16, { imdb: AOT, season: 4 }, '2020-12-07'),
  entry('al131681', 'Attack on Titan Final Season Part 2', 12, { imdb: AOT, season: 4, offset: 16 }, '2022-01-10'),
];

test('AoT: parts of a TheTVDB season are one season, numbered like TheTVDB', () => {
  const groups = groupEntries(aot);
  assert.deepEqual(groups.map((g) => g.entries.map((e) => e.id)), [
    ['al16498'], ['al20958'], ['al99147', 'al104578'], ['al110277', 'al131681'],
  ]);
  assert.deepEqual(seasonNumbers(groups), [1, 2, 3, 4]);
  const { seasons } = composeSeasons({ entries: aot, currentId: 'al131681', shows: {}, today: TODAY });
  assert.deepEqual(seasons.map((s) => [s.label, s.count]), [['Saison 1', 25], ['Saison 2', 12], ['Saison 3', 22], ['Saison 4', 28]]);
  const s4 = seasons[3];
  assert.deepEqual(s4.parts, [
    { seriesId: 'al110277', from: 1, to: 16, shownFrom: 1, label: 'Partie 1' },
    { seriesId: 'al131681', from: 1, to: 12, shownFrom: 17, label: 'Partie 2' },
  ]);
  // Part 2 ep. 1 = "S4 · Ép. 17"; each part keeps its own AniList id.
  assert.equal(seasonOf(seasons, 'al131681', 1), s4);
  assert.equal(shownNumber(s4, 'al131681', 1), 17);
  assert.equal(episodeBadge(s4, 'al131681', 1, seasons.length), 'S4 · Ép. 17');
  assert.equal(chronologyName(s4, 28), 'S4 Ép. 28');
  assert.equal(seasonDetail(s4, (d) => d.slice(0, 7)), '2020-12 · 28 ép. · 2 parties');
});

test('without TheTVDB data, "Part 2" / "Cour 2" titles still group (Spy x Family, Mushoku Tensei)', () => {
  const sxf = [
    entry('a', 'SPY x FAMILY', 12, undefined),
    entry('b', 'SPY x FAMILY Cour 2', 13, undefined),
    entry('c', 'SPY x FAMILY Season 2', 12, undefined),
    entry('d', 'SPY x FAMILY Season 3', 13, undefined),
  ];
  const { seasons } = composeSeasons({ entries: sxf, currentId: 'a', shows: {}, today: TODAY });
  assert.deepEqual(seasons.map((s) => [s.label, s.count, s.parts.length]), [['Saison 1', 25, 2], ['Saison 2', 12, 1], ['Saison 3', 13, 1]]);
  const mt = groupEntries([
    entry('a', 'Mushoku Tensei: Jobless Reincarnation', 11, null),
    entry('b', 'Mushoku Tensei: Jobless Reincarnation Cour 2', 12, null),
    entry('c', 'Mushoku Tensei: Jobless Reincarnation Season 2', 13, null),
    entry('d', 'Mushoku Tensei: Jobless Reincarnation Season 2 Part 2', 12, null),
  ]);
  assert.deepEqual(mt.map((g) => g.entries.length), [2, 2]);
});

test('TheTVDB wins over titles: Demon Slayer arcs are separate seasons, Re:Zero S2 parts one', () => {
  const DS = 'tt9335498';
  const ds = groupEntries([
    entry('s1', 'Demon Slayer: Kimetsu no Yaiba', 26, { imdb: DS, season: 1 }),
    entry('s2', 'Demon Slayer: Kimetsu no Yaiba Mugen Train Arc', 7, { imdb: DS, season: 2 }),
    entry('s3', 'Demon Slayer: Kimetsu no Yaiba Entertainment District Arc', 11, { imdb: DS, season: 3 }),
    entry('s4', 'Demon Slayer: Kimetsu no Yaiba Swordsmith Village Arc', 11, { imdb: DS, season: 4 }),
    entry('s5', 'Demon Slayer: Kimetsu no Yaiba Hashira Training Arc', 8, { imdb: DS, season: 5 }),
  ]);
  assert.deepEqual(ds.map((g) => g.entries.length), [1, 1, 1, 1, 1]);
  assert.deepEqual(seasonNumbers(ds), [1, 2, 3, 4, 5]);
  const RZ = 'tt5607616';
  const rz = groupEntries([
    entry('r1', 'Re:ZERO', 25, { imdb: RZ, season: 1 }),
    entry('r2', 'Re:ZERO Season 2', 13, { imdb: RZ, season: 2 }),
    entry('r3', 'Re:ZERO Season 2 Part 2', 12, { imdb: RZ, season: 2, offset: 13 }),
    entry('r4', 'Re:ZERO Season 3', 16, { imdb: RZ, season: 3 }),
    // A "Part 2" title that TheTVDB files as its own season stays separate.
    entry('r5', 'Re:ZERO Season 3 Part 2', 10, { imdb: RZ, season: 4 }),
  ]);
  assert.deepEqual(rz.map((g) => g.entries.map((e) => e.id)), [['r1'], ['r2', 'r3'], ['r4'], ['r5']]);
});

test('season numbers: TheTVDB when consistent, else 1, 2, 3…', () => {
  const g = (season?: number) => ({ entries: [entry('x', 'x', 1, season == null ? null : { imdb: 'tt1', season })] });
  assert.deepEqual(seasonNumbers([g(1), g(), g(3)]), [1, 2, 3]);
  assert.deepEqual(seasonNumbers([g(2), g(3)]), [2, 3], 'a franchise starting at TheTVDB season 2 keeps it');
  assert.deepEqual(seasonNumbers([g(), g(1)]), [1, 2], 'conflict: sequential');
  assert.deepEqual(seasonNumbers([g(3), g(2)]), [1, 2]);
});

test('a franchise of several shows (Naruto → Shippuden → Boruto) is labelled by title', () => {
  const { seasons } = composeSeasons({
    entries: [
      entry('al20', 'Naruto', 220, { imdb: 'tt0409591' }),
      entry('al1735', 'Naruto: Shippuden', 500, { imdb: 'tt0988824' }),
      entry('al97938', 'Boruto: Naruto Next Generations', 293, { imdb: 'tt6342474', season: 1 }),
    ],
    currentId: 'al20',
    shows: {},
    today: TODAY,
  });
  assert.deepEqual(seasons.map((s) => [s.label, s.number]), [['Naruto', undefined], ['Naruto: Shippuden', undefined], ['Boruto: Naruto Next Generations', undefined]]);
  assert.equal(episodeBadge(seasons[1], 'al1735', 3, 3), 'Ép. 3');
  assert.equal(chronologyName(seasons[0], 12), 'l’ép. 12 (Naruto)');
});

// ---------- mapping ----------

test('runs: absolute ↔ season / episode both ways', () => {
  const { eps } = show([8, 22, 17], '1999-10-20');
  const runs = cumulativeRuns(eps, 47);
  assert.deepEqual(runs, [
    { from: 1, count: 8, season: 1, episode: 1 },
    { from: 9, count: 22, season: 2, episode: 1 },
    { from: 31, count: 17, season: 3, episode: 1 },
  ]);
  assert.deepEqual(pairOf(runs, 9), { season: 2, episode: 1 });
  assert.deepEqual(pairOf(runs, 47), { season: 3, episode: 17 });
  assert.equal(pairOf(runs, 48), undefined);
  assert.equal(absoluteOf(runs, 3, 17), 47);
  assert.equal(absoluteOf(runs, 2, 23), undefined);
  // Split-cour offset: AoT Final Season Part 2 ep. 1 = S4E17.
  const p2 = [{ from: 1, count: 12, season: 4, episode: 17 }];
  assert.deepEqual(pairOf(p2, 1), { season: 4, episode: 17 });
  assert.equal(absoluteOf(p2, 4, 28), 12);
  // A table with a hole (One Piece 590 has no IMDb pair).
  const pairs = runsFromPairs([1, 2, 4, 5].map((n) => ({ n, season: 1, episode: n < 3 ? n : n - 1 })), 5);
  assert.deepEqual(pairs, [{ from: 1, count: 2, season: 1, episode: 1 }, { from: 4, count: 2, season: 1, episode: 3 }]);
  assert.equal(pairOf(pairs, 3), undefined);
  assert.equal(absoluteOf(pairs, 1, 3), 4);
});

// One Piece: 23 TheTVDB seasons; episode 590 (the Toriko × Dragon Ball crossover) is in
// TheTVDB's specials, so Cinemeta lists 1179 regular episodes for 1180 aired.
const OP_SIZES = [8, 22, 17, 13, 9, 22, 39, 13, 52, 31, 99, 56, 100, 35, 62, 50, 118, 33, 98, 14, 194, 70, 25];
const op = show(OP_SIZES, '1999-10-20', { skip: [590], specials: 63 });
const opEntry = entry('al21', 'ONE PIECE', 1180, { imdb: 'tt0388629' }, '1999-10-20', true);
const opPairs = Array.from({ length: 1180 }, (_, i) => i + 1).map((n) => ({
  n,
  season: op.real[n]?.s,
  episode: op.real[n]?.e,
  date: addDays('1999-10-20', 7 * (n - 1)),
}));

test('One Piece: one missing episode in the listing → no titles from a shifted numbering', () => {
  assert.equal(op.listed, 1179);
  const out = composeSeasons({ entries: [opEntry], currentId: 'al21', shows: { tt0388629: op.eps }, today: TODAY });
  assert.equal(out.rejected.al21, 'count');
  assert.equal(out.mappings.al21, undefined, 'AniList-only display');
  assert.equal(out.wantPairs, true, 'asks for the anime-kitsu table');
  assert.deepEqual(out.seasons.map((s) => [s.label, s.count]), [['Saison 1', 1180]]);
});

test('One Piece: with the anime-kitsu table, 23 sub-seasons and the right titles', () => {
  const out = composeSeasons({ entries: [opEntry], currentId: 'al21', shows: { tt0388629: op.eps }, pairs: opPairs, today: TODAY });
  assert.equal(out.mappings.al21?.source, 'pairs');
  const { seasons } = out;
  assert.equal(seasons.length, 23);
  assert.deepEqual(seasons.map((s) => s.label).slice(0, 2), ['Saison 1', 'Saison 2']);
  assert.ok(seasons.every((s) => s.absolute && s.parts.length === 1 && s.parts[0].seriesId === 'al21'));
  const range = (n: number) => [seasons[n - 1].parts[0].from, seasons[n - 1].parts[0].to];
  assert.deepEqual(range(1), [1, 8]);
  assert.deepEqual(range(16), [579, 628], 'episode 590 (no pair) stays in its season');
  assert.deepEqual(range(21), [892, 1085]);
  assert.deepEqual(range(22), [1086, 1155]);
  assert.deepEqual(range(23), [1156, 1180]);
  assert.equal(seasons.reduce((n, s) => n + s.count, 0), 1180);
  // Absolute numbers stay (al21 ep. 1000), the badge adds the season.
  const s21 = seasonOf(seasons, 'al21', 1000)!;
  assert.equal(s21.label, 'Saison 21');
  assert.equal(episodeBadge(s21, 'al21', 1000, seasons.length), 'S21 · Ép. 1000');
  assert.equal(chronologyName(s21, 1000), 'l’ép. 1000');
  const idx = indexShow(op.eps);
  const runs = out.mappings.al21.runs;
  assert.deepEqual(infoOf(runs, idx, 1000), { season: 21, episode: 109, title: 'T1000', date: addDays('1999-10-20', 7 * 999) });
  assert.equal(infoOf(runs, idx, 590), undefined, 'no title rather than a wrong one');
  assert.equal(infoOf(runs, idx, 591)?.title, 'T591');
  assert.equal(s21.from, addDays('1999-10-20', 7 * 891));
});

test('One Piece: a table that disagrees with Cinemeta is refused', () => {
  // Shifted by one episode from 600 on: dates a week off nearly everywhere after.
  const shifted = opPairs.map((p) => (p.n >= 600 ? { ...p, date: addDays(p.date, 7) } : p));
  const out = composeSeasons({ entries: [opEntry], currentId: 'al21', shows: { tt0388629: op.eps }, pairs: shifted, today: TODAY });
  assert.equal(out.mappings.al21, undefined);
  assert.equal(out.seasons.length, 1);
  // A pair pointing at an episode Cinemeta does not have.
  const ghost = [...opPairs.slice(0, -1), { n: 1180, season: 23, episode: 99, date: opPairs[1179].date }];
  assert.equal(composeSeasons({ entries: [opEntry], currentId: 'al21', shows: { tt0388629: op.eps }, pairs: ghost, today: TODAY }).mappings.al21, undefined);
});

test('Detective Conan / Naruto Shippuden: exact absolute listing → sub-seasons without any extra table', () => {
  const conan = show([28, 26, 28, 24, 28], '1996-01-08');
  const e = entry('al235', 'Detective Conan', 134, { imdb: 'tt0131179' }, '1996-01-08', true);
  const out = composeSeasons({ entries: [e], currentId: 'al235', shows: { tt0131179: conan.eps }, today: TODAY });
  assert.equal(out.mappings.al235?.source, 'absolute');
  assert.equal(out.wantPairs, false);
  assert.deepEqual(out.seasons.map((s) => [s.label, s.parts[0].from, s.parts[0].to]), [
    ['Saison 1', 1, 28], ['Saison 2', 29, 54], ['Saison 3', 55, 82], ['Saison 4', 83, 106], ['Saison 5', 107, 134],
  ]);
  // A short show (≤ 60 episodes) has no sub-seasons, titles all the same.
  const short = composeSeasons({ entries: [{ ...e, episodes: 54 }], currentId: 'al235', shows: { tt0131179: show([28, 26], '1996-01-08').eps }, today: TODAY });
  assert.equal(short.seasons.length, 1);
  assert.equal(short.mappings.al235?.source, 'absolute');
});

test('mismatch: a first air date off by more than 2 days drops the titles (Mushoku Tensei S2 "episode 0")', () => {
  const MT = 'tt13293588';
  // TheTVDB season 2 has 24 episodes, AniList's two parts 13 + 12 (its ep. 1 is TheTVDB's special).
  const listing = show([23, 24], '2021-01-10').eps;
  const s2start = listing.find((x) => x.s === 2 && x.e === 1)!.date!;
  const entries = [
    entry('p1', 'Mushoku Tensei', 11, { imdb: MT, season: 1 }, '2021-01-10'),
    entry('p2', 'Mushoku Tensei Cour 2', 12, { imdb: MT, season: 1, offset: 11 }, addDays('2021-01-10', 77)),
    entry('q1', 'Mushoku Tensei Season 2', 13, { imdb: MT, season: 2 }, addDays(s2start, -6)),
    entry('q2', 'Mushoku Tensei Season 2 Part 2', 12, { imdb: MT, season: 2, offset: 12 }, addDays(s2start, 7 * 12)),
  ];
  const out = composeSeasons({ entries, currentId: 'q1', shows: { [MT]: listing }, today: TODAY });
  assert.equal(out.rejected.q1, 'start');
  assert.deepEqual(Object.keys(out.mappings).sort(), ['p1', 'p2', 'q2']);
  assert.deepEqual(out.seasons.map((s) => [s.label, s.count]), [['Saison 1', 23], ['Saison 2', 25]], 'display still grouped');
});

test('mismatch: too few listed episodes, or two entries on the same episodes', () => {
  const listing = show([12], '2022-04-09').eps;
  const v = verifyRuns({ episodes: 24, start: '2022-04-09' }, [{ from: 1, count: 24, season: 1, episode: 1 }], listing, { today: TODAY, absolute: false });
  assert.deepEqual(v, { ok: false, reason: 'count', matched: 12 });
  // A listing one episode behind on a season still airing is fine.
  const lag = verifyRuns({ episodes: 13, start: '2022-04-09', ongoing: true }, [{ from: 1, count: 13, season: 1, episode: 1 }], listing, { today: TODAY, absolute: false });
  assert.equal(lag.ok, true);
  // Same TheTVDB episodes claimed twice: neither is trusted.
  const out = composeSeasons({
    entries: [entry('x', 'X', 12, { imdb: 'tt1', season: 1 }, '2022-04-09'), entry('y', 'X Movie Cut', 12, { imdb: 'tt1', season: 1 })],
    currentId: 'x',
    shows: { tt1: listing },
    today: TODAY,
  });
  assert.deepEqual(out.mappings, {});
  assert.deepEqual(out.rejected, { x: 'overlap', y: 'overlap' });
  // Without a day for the start, the counts must match exactly.
  const nodate = verifyRuns({ episodes: 13 }, [{ from: 1, count: 13, season: 1, episode: 1 }], listing, { today: TODAY, absolute: false });
  assert.equal(nodate.ok, false);
});

test('absolute numbering is never guessed for an IMDb id shared by several seasons', () => {
  const listing = show([12, 12], '2020-01-01').eps;
  const out = composeSeasons({
    entries: [entry('a', 'A', 12, { imdb: 'tt9' }, '2020-01-01'), entry('b', 'A Season 2', 12, { imdb: 'tt9' })],
    currentId: 'b',
    shows: { tt9: listing },
    today: TODAY,
  });
  assert.deepEqual(out.mappings, {});
  assert.equal(out.rejected.b, 'shared');
});

// ---------- specials ----------

test('specials: deduped, in airing order, seasons left out', () => {
  const list = sortSpecials(
    [
      { anilistId: 3, title: 'Film Z', format: 'MOVIE', episodes: 1, start: '2012-12-15' },
      { anilistId: 1, title: 'OVA', format: 'OVA', episodes: 1, start: '1998-07-26' },
      { anilistId: 3, title: 'Film Z', format: 'MOVIE', episodes: 1, start: '2012-12-15' },
      { anilistId: 9, title: 'Season', format: 'TV', episodes: 12, start: '2001-01-01' },
      { anilistId: 4, title: 'Undated', format: 'SPECIAL', episodes: 1 },
      { anilistId: 5, title: 'Year only', format: 'SPECIAL', episodes: 1, year: 2005 },
    ],
    new Set([9]),
  );
  assert.deepEqual(list.map((x) => x.anilistId), [1, 5, 3, 4]);
});

test('specials: position in the chronology', () => {
  const eps = [
    { date: '2013-04-07', label: 'S1 Ép. 1' },
    { date: '2013-04-14', label: 'S1 Ép. 2' },
    { date: '2013-04-21', label: 'S1 Ép. 3' },
  ];
  assert.equal(chronologyLabel('2013-04-15', eps), 'après S1 Ép. 2');
  assert.equal(chronologyLabel('2013-04-14', eps), 'après S1 Ép. 2', 'same day: after it');
  assert.equal(chronologyLabel('2012-01-01', eps), 'avant S1 Ép. 1');
  assert.equal(chronologyLabel('2020-01-01', eps), 'après S1 Ép. 3', 'finished show: after the finale');
  assert.equal(chronologyLabel('2020-01-01', eps, true), undefined, 'show still airing: the listing may be behind');
  assert.equal(chronologyLabel(undefined, eps), undefined);
  assert.equal(chronologyLabel('2013-04-15', []), undefined);
});
