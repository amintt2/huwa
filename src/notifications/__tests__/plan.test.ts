/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  anilistIdOf,
  idsToFetch,
  MAX_SCHEDULED,
  planNotifications,
  pruneEpisodeReminders,
  refreshEpisodeReminders,
  reminderKey,
  type EpisodeReminder,
  type PlannedEpisode,
  type PlanSources,
} from '../plan';

const NOW = 1_800_000_000; // unix seconds
const nowMs = NOW * 1000;
const H = 3600;
const ep = (anilistId: number, episode: number, airingAt: number, title = `S${anilistId}`): PlannedEpisode => ({ anilistId, episode, airingAt, title });
const bell = (seriesId: string, episode: number, airingAt: number): [string, EpisodeReminder] => [reminderKey(seriesId, episode), { seriesId, episode, airingAt }];
const sources = (p: Partial<PlanSources> = {}): PlanSources => ({
  myList: [],
  listEnabled: true,
  seriesReminders: [],
  episodeReminders: {},
  ...p,
});

test('series ids: only AniList anime count', () => {
  assert.equal(anilistIdOf('al123'), 123);
  assert.equal(anilistIdOf('alm123'), null);
  assert.equal(anilistIdOf('void'), null);
  assert.equal(anilistIdOf('al12-e3'), null);
});

test('fetch: Ma liste (setting on) ∪ series bells ∪ episode bells, each once', () => {
  const src = sources({
    myList: ['al1', 'al2', 'void', 'alm9'],
    seriesReminders: ['al2', 'al3'],
    episodeReminders: Object.fromEntries([bell('al4', 8, NOW + H), bell('al1', 5, NOW + H)]),
  });
  assert.deepEqual(idsToFetch(src).sort(), [1, 2, 3, 4]);
  // Setting off: "Ma liste" is not followed, the bells still are.
  assert.deepEqual(idsToFetch({ ...src, listEnabled: false }).sort(), [1, 2, 3, 4]);
  assert.deepEqual(idsToFetch(sources({ myList: ['al1'], listEnabled: false })), []);
});

test('merge: list and series bells follow every upcoming episode, episode bells only theirs', () => {
  const src = sources({
    myList: ['al1'],
    seriesReminders: ['al2'],
    episodeReminders: Object.fromEntries([bell('al3', 8, NOW + 5 * H)]),
  });
  const upcoming = [ep(1, 4, NOW + 2 * H), ep(2, 10, NOW + H), ep(3, 7, NOW + 3 * H), ep(3, 8, NOW + 6 * H), ep(9, 1, NOW + H)];
  const plan = planNotifications(src, upcoming, { now: nowMs });
  assert.deepEqual(
    plan.map((u) => `${u.anilistId}-${u.episode}`),
    ['2-10', '1-4', '3-8'],
  );
  // The episode bell takes the fresher time AniList gives (postponed by an hour).
  assert.equal(plan[2].airingAt, NOW + 6 * H);
});

test('global setting off: "Ma liste" is not notified, bells are', () => {
  const src = sources({ myList: ['al1'], listEnabled: false, seriesReminders: ['al2'] });
  const plan = planNotifications(src, [ep(1, 4, NOW + H), ep(2, 3, NOW + H)], { now: nowMs });
  assert.deepEqual(plan.map((u) => u.anilistId), [2]);
});

test('dedupe: a series in Ma liste with its bell and an episode bell is notified once per episode', () => {
  const src = sources({
    myList: ['al1'],
    seriesReminders: ['al1'],
    episodeReminders: Object.fromEntries([bell('al1', 4, NOW + H)]),
  });
  const upcoming = [ep(1, 4, NOW + H), ep(1, 4, NOW + H), ep(1, 5, NOW + H + 7 * 24 * H)];
  const plan = planNotifications(src, upcoming, { now: nowMs });
  assert.deepEqual(plan.map((u) => u.episode), [4, 5]);
});

test('episode bell AniList did not return (beyond the next 3, offline): stored time and catalog title', () => {
  const src = sources({ episodeReminders: Object.fromEntries([bell('al7', 11, NOW + 30 * 24 * H)]) });
  const plan = planNotifications(src, [], { now: nowMs, titleOf: (id) => (id === 'al7' ? 'Frieren' : undefined) });
  assert.deepEqual(plan, [{ anilistId: 7, episode: 11, airingAt: NOW + 30 * 24 * H, title: 'Frieren' }]);
});

test('cap: soonest first, at most 60 (iOS keeps 64 pending)', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `al${i + 1}`);
  const upcoming = ids.flatMap((_, i) => [1, 2, 3].map((n) => ep(i + 1, n, NOW + (n * 100 + (30 - i)) * 60)));
  const plan = planNotifications(sources({ seriesReminders: ids }), upcoming, { now: nowMs });
  assert.equal(plan.length, MAX_SCHEDULED);
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i - 1].airingAt <= plan[i].airingAt);
  // Every first and second episode (60) beats every third one.
  assert.ok(plan.every((u) => u.episode <= 2));
  assert.equal(planNotifications(sources({ seriesReminders: ids }), upcoming, { now: nowMs, max: 5 }).length, 5);
});

test('past and imminent episodes are not scheduled', () => {
  const src = sources({ seriesReminders: ['al1'] });
  const plan = planNotifications(src, [ep(1, 1, NOW - H), ep(1, 2, NOW + 30), ep(1, 3, NOW + 120)], { now: nowMs });
  assert.deepEqual(plan.map((u) => u.episode), [3]);
});

test('cleanup: aired episode bells are dropped, the record is kept when nothing changes', () => {
  const live = Object.fromEntries([bell('al1', 8, NOW + H), bell('al2', 3, NOW + 2 * H)]);
  assert.equal(pruneEpisodeReminders(live, nowMs), live);
  const mixed = { ...live, ...Object.fromEntries([bell('al1', 7, NOW - H), bell('al3', 1, NOW)]) };
  assert.deepEqual(Object.keys(pruneEpisodeReminders(mixed, nowMs)).sort(), ['al1:8', 'al2:3']);
});

test('cleanup: a postponed episode keeps its bell with the new time', () => {
  const bells = Object.fromEntries([bell('al1', 8, NOW - H), bell('al2', 3, NOW + H)]);
  // AniList now says episode 8 airs next week (it was due an hour ago).
  const refreshed = refreshEpisodeReminders(bells, [ep(1, 8, NOW + 7 * 24 * H), ep(2, 3, NOW + H)]);
  assert.equal(refreshed['al1:8'].airingAt, NOW + 7 * 24 * H);
  assert.deepEqual(Object.keys(pruneEpisodeReminders(refreshed, nowMs)).sort(), ['al1:8', 'al2:3']);
  // Same times: same object (no store write).
  assert.equal(refreshEpisodeReminders(refreshed, [ep(1, 8, NOW + 7 * 24 * H)]), refreshed);
});
