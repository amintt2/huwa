/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  airedEpisodeCount,
  airedFromSchedule,
  airingDate,
  mergeSchedule,
  nextEpisodeLine,
  relativeAiring,
  relativeTick,
  shortAiring,
  upcomingLabel,
  upcomingRows,
} from '../airing';

// Local time everywhere: dates are built with the local constructor, like the app shows them.
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime() / 1000;
const NOW = at(2026, 10, 6, 20, 0); // mardi 6 oct. 2026, 20:00
const nowMs = NOW * 1000;
const WEEK = 7 * 86_400;
const weekly = (from: number, count: number, first: number) =>
  Array.from({ length: count }, (_, i) => ({ episode: from + i, airingAt: first + i * WEEK }));

test('aired count: a releasing season counts what aired, not its announced total', () => {
  assert.equal(airedEpisodeCount(12, { episode: 8, airingAt: NOW + 3600 }, nowMs), 7);
  // The next airing already passed (stale catalog): it is out.
  assert.equal(airedEpisodeCount(12, { episode: 8, airingAt: NOW - 60 }, nowMs), 8);
  // Total unknown (long-running show).
  assert.equal(airedEpisodeCount(null, { episode: 1150, airingAt: NOW + 60 }, nowMs), 1149);
  // Finished season: the total.
  assert.equal(airedEpisodeCount(24, null, nowMs), 24);
  assert.equal(airedEpisodeCount(null, null, nowMs), 0);
  // Never past the announced total, never negative.
  assert.equal(airedEpisodeCount(12, { episode: 13, airingAt: NOW - 60 }, nowMs), 12);
  assert.equal(airedEpisodeCount(12, { episode: 1, airingAt: NOW + 60 }, nowMs), 0);
});

test('aired count follows the schedule as episodes air', () => {
  const schedule = weekly(8, 5, NOW + 3600);
  assert.equal(airedFromSchedule(12, schedule, nowMs), 7);
  // Episode 8 aired while the page was open.
  assert.equal(airedFromSchedule(12, schedule, nowMs + 3601_000), 8);
  // Offline weeks later, the cached schedule fully aired: its last episode.
  assert.equal(airedFromSchedule(12, schedule, nowMs + 60 * 86_400_000), 12);
  assert.equal(airedFromSchedule(12, [], nowMs), 12);
});

test('schedule merge: one entry per episode, the first list wins, sorted', () => {
  const merged = mergeSchedule(
    [{ episode: 9, airingAt: 200 }, { episode: 8, airingAt: 100 }],
    [{ episode: 8, airingAt: 999 }, { episode: 10, airingAt: 300 }],
  );
  assert.deepEqual(merged, [
    { episode: 8, airingAt: 100 },
    { episode: 9, airingAt: 200 },
    { episode: 10, airingAt: 300 },
  ]);
});

test('upcoming rows: after the aired ones, still to air, within the total', () => {
  // Episodes 6..13 weekly: 6 and 7 aired, 8 airs in an hour (plus a duplicate entry for 8).
  const schedule = [...weekly(6, 8, NOW - 2 * WEEK + 3600), { episode: 8, airingAt: NOW + 10 }];
  const rows = upcomingRows(schedule, 7, 12, nowMs);
  assert.deepEqual(rows.map((r) => r.episode), [8, 9, 10, 11, 12]);
  assert.equal(rows[0].airingAt, NOW + 3600);
  // An episode already listed as aired is never repeated.
  assert.deepEqual(upcomingRows(schedule, 9, 12, nowMs).map((r) => r.episode), [10, 11, 12]);
  // Total unknown: everything still to air.
  assert.equal(upcomingRows(schedule, 7, null, nowMs).at(-1)?.episode, 13);
  // Once an episode airs, it leaves the upcoming rows (and the aired count takes it).
  const later = nowMs + 3601_000;
  const aired = airedFromSchedule(12, schedule, later);
  assert.equal(aired, 8);
  assert.deepEqual(upcomingRows(schedule, aired, 12, later).map((r) => r.episode), [9, 10, 11, 12]);
});

test('row labels in French, local time', () => {
  const thu = at(2026, 10, 8, 17, 30);
  assert.equal(airingDate(thu), 'jeudi 8 oct.');
  assert.equal(upcomingLabel({ episode: 8, airingAt: thu }), 'Ép. 8 · jeudi 8 oct. · 17:30');
  assert.equal(airingDate(at(2026, 2, 1, 9, 5)), 'dimanche 1 févr.');
  assert.equal(upcomingLabel({ episode: 1, airingAt: at(2026, 8, 3, 9, 5) }), 'Ép. 1 · lundi 3 août · 09:05');
});

test('next episode line: today, tomorrow, this week, later', () => {
  assert.equal(shortAiring(at(2026, 10, 6, 23, 15), nowMs), 'aujourd’hui 23:15');
  assert.equal(shortAiring(at(2026, 10, 7, 0, 30), nowMs), 'demain 00:30');
  assert.equal(shortAiring(at(2026, 10, 8, 17, 30), nowMs), 'jeu. 17:30');
  assert.equal(shortAiring(at(2026, 10, 16, 17, 30), nowMs), 'ven. 16 oct. 17:30');
  assert.equal(nextEpisodeLine({ episode: 8, airingAt: at(2026, 10, 8, 17, 30) }, nowMs), 'Prochain épisode : Ép. 8 · jeu. 17:30');
});

test('relative label: days, then a live countdown under 24 h', () => {
  assert.equal(relativeAiring(at(2026, 10, 9, 17, 30), nowMs), 'dans 3 j');
  // More than 24 h ahead but tomorrow on the calendar.
  assert.equal(relativeAiring(at(2026, 10, 7, 21, 0), nowMs), 'demain');
  // Under 24 h: hours, minutes, seconds (even when it is tomorrow).
  assert.equal(relativeAiring(at(2026, 10, 7, 1, 7, 9), nowMs), 'dans 5 h 07 min 09 s');
  assert.equal(relativeAiring(NOW + 7 * 60 + 9, nowMs), 'dans 7 min 09 s');
  assert.equal(relativeAiring(NOW + 9, nowMs), 'dans 9 s');
  // Partial seconds round up: never "dans 0 s" before it airs.
  assert.equal(relativeAiring(NOW + 1, nowMs + 999), 'dans 1 s');
  assert.equal(relativeAiring(NOW, nowMs), 'maintenant');
  assert.equal(relativeAiring(NOW - 30, nowMs), 'maintenant');
});

test('countdown ticks every second under 24 h, every minute otherwise', () => {
  assert.equal(relativeTick(NOW + 3600, nowMs), 1000);
  assert.equal(relativeTick(NOW + 3 * 86_400, nowMs), 60_000);
});
