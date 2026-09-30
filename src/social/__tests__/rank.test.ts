/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JournalEntry } from '../../p2p/contract';
import { badges } from '../badges';
import { DAY, DEFAULT_RULES, replayJournal, streaks, tierOf } from '../rank';

const T0 = Date.UTC(2026, 0, 5, 10);
const MIN = 60_000;
const ep = (unit: number, ts: number, work = '1'): JournalEntry => ({ type: 'ep', work, unit, ts });
const ch = (unit: number, ts: number, work = '1'): JournalEntry => ({ type: 'ch', work, unit, ts });
const cm = (ts: number, work = '1'): JournalEntry => ({ type: 'comment', work, ts });

test('counts plausible episodes', () => {
  const r = replayJournal([ep(1, T0), ep(2, T0 + 25 * MIN), ep(3, T0 + 50 * MIN)]);
  assert.equal(r.counts.ep, 3);
  assert.equal(r.xp, 30);
  assert.equal(r.rejected.length, 0);
});

test('rejects episodes closer than 20 min, duplicates and backdated entries', () => {
  const r = replayJournal([ep(1, T0), ep(2, T0 + 5 * MIN), ep(1, T0 + 60 * MIN), ep(3, T0 - DAY)]);
  assert.equal(r.counts.ep, 1);
  assert.deepEqual(
    r.rejected.map((x) => x.reason),
    ['trop-rapide', 'doublon', 'horodatage'],
  );
});

test('caps episodes per day at 30', () => {
  const list = Array.from({ length: 40 }, (_, i) => ep(i + 1, T0 - 10 * 3600_000 + i * 21 * MIN));
  // All inside the same UTC day? 40 × 21 min = 14 h starting at 00:00 → yes.
  const r = replayJournal(list);
  assert.equal(r.counts.ep, DEFAULT_RULES.epPerDay);
  assert.ok(r.rejected.every((x) => x.reason === 'quota-jour'));
});

test('daily XP cap', () => {
  const rules = { ...DEFAULT_RULES, dailyXpCap: 25 };
  const r = replayJournal([ep(1, T0), ep(2, T0 + 30 * MIN), ep(3, T0 + 60 * MIN)], rules);
  assert.equal(r.baseXp, 25);
  assert.equal(r.accepted[2].xp, 5);
});

test('future entries rejected only when `now` is given', () => {
  const future = [ep(1, T0 + 10 * DAY)];
  assert.equal(replayJournal(future, DEFAULT_RULES, T0).rejected[0]?.reason, 'futur');
  assert.equal(replayJournal(future).counts.ep, 1);
});

test('invalid entries rejected', () => {
  const r = replayJournal([{ type: 'ep', work: '', unit: 1, ts: T0 } as JournalEntry, { type: 'ep', work: '1', unit: -1, ts: T0 } as JournalEntry]);
  assert.equal(r.rejected.length, 2);
});

test('seniority bonus', () => {
  const r = replayJournal([ep(1, T0), ep(2, T0 + 90 * DAY)]);
  assert.equal(r.seniorityPct, 3);
  assert.equal(r.xp, Math.round(20 * 1.03));
});

test('replay is deterministic', () => {
  const j = [ep(1, T0), ch(1, T0 + MIN), cm(T0 + 2 * MIN), ep(2, T0 + 30 * MIN)];
  assert.deepEqual(replayJournal(j), replayJournal(structuredClone(j)));
});

test('tiers', () => {
  assert.equal(tierOf(0).tier, 'Novice');
  assert.equal(tierOf(100).tier, 'Initié');
  assert.equal(tierOf(99_999).nextTier, undefined);
  assert.equal(tierOf(200).progress, 0.5);
});

test('streaks', () => {
  assert.deepEqual(streaks([1, 2, 3, 5, 6], 6), { best: 3, current: 2 });
  assert.deepEqual(streaks([1, 2], 10), { best: 2, current: 0 });
});

test('badges come from accepted entries only', () => {
  const j: JournalEntry[] = [ep(1, T0), ep(2, T0 + MIN), ch(1, T0 + 2 * MIN, '1')];
  const b = Object.fromEntries(badges(j).map((x) => [x.id, x]));
  assert.equal(b['first-ep'].earned, true);
  assert.equal(b['first-ch'].earned, true);
  assert.equal(b.bridge.earned, true);
  assert.equal(b.binge.progress, 1 / 6);
  assert.equal(b['eps-100'].earned, false);
});

test('streak badge', () => {
  const j = Array.from({ length: 7 }, (_, i) => cm(T0 + i * DAY));
  const b = badges(j).find((x) => x.id === 'streak-7')!;
  assert.equal(b.earned, true);
  assert.equal(b.earnedAt, T0 + 6 * DAY);
});
