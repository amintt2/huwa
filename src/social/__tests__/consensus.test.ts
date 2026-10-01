/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeSeasonStates } from '../../data/mapping-consensus';
import type { MappingProposal } from '../../p2p/contract';
import { authorWeight, CONSENSUS_RULES, latestPerAuthor, tally, type Vote } from '../consensus';

const vote = (author: string, value: number, ts = 1, field = 'end'): Vote<number> => ({ author, field, value, key: String(value), ts });
const flat = (w: number) => () => w;

test('weights: rank tiers, capped, new identities weigh little, follows help', () => {
  assert.equal(authorWeight({}), 0.1);
  assert.equal(authorWeight({ xp: 0 }), 0.1);
  assert.equal(authorWeight({ xp: 350 }), 0.5);
  assert.equal(authorWeight({ xp: 1e9 }), CONSENSUS_RULES.cap);
  assert.equal(authorWeight({ xp: 0, followed: true }), 0.6);
  assert.equal(authorWeight({ xp: 1e9, followed: true }), 1);
});

test('one active proposal per author and field: the newest replaces the older ones', () => {
  const latest = latestPerAuthor([vote('a', 10, 1), vote('a', 12, 5), vote('a', 11, 3), vote('b', 10, 1), vote('a', 99, 2, 'ep:1')]);
  assert.deepEqual(latest.map((v) => [v.author, v.field, v.value]).sort(), [['a', 'end', 12], ['a', 'ep:1', 99], ['b', 'end', 10]]);
  const t = tally([vote('a', 10, 1), vote('a', 12, 5), vote('b', 12), vote('c', 12)], { weightOf: flat(1) });
  assert.equal(t.leader!.value, 12);
  assert.deepEqual(t.leader!.authors, ['a', 'b', 'c']);
  assert.equal(t.verified, true);
});

test('verification needs distinct authors, enough weight and a clear majority', () => {
  // Two trusted authors only: not enough distinct people.
  assert.equal(tally([vote('a', 10), vote('b', 10)], { weightOf: flat(1) }).verified, false);
  // Ten fresh identities (sybils) weigh 1.0 together: below the minimum weight.
  const sybils = Array.from({ length: 10 }, (_, i) => vote(`s${i}`, 99));
  const t = tally(sybils, { weightOf: () => authorWeight({}) });
  assert.equal(t.leader!.authors.length, 10);
  assert.equal(t.verified, false);
  // A single heavy author is capped: it cannot outweigh three regulars.
  const capped = tally([vote('whale', 5), vote('a', 10), vote('b', 10), vote('c', 10)], { weightOf: (a) => (a === 'whale' ? 50 : 0.7) });
  assert.equal(capped.leader!.value, 10);
  assert.equal(capped.verified, true);
  // No clear majority (3 vs 2 regulars): stays a proposal.
  const split = tally([vote('a', 10), vote('b', 10), vote('c', 10), vote('d', 11), vote('e', 11)], { weightOf: flat(1) });
  assert.equal(split.leader!.value, 10);
  assert.equal(split.verified, false);
});

test('blocked authors and values that do not fit the series are ignored', () => {
  const votes = [vote('a', 10), vote('b', 10), vote('c', 10), vote('troll1', 500), vote('troll2', 500), vote('troll3', 500)];
  const blocked = tally(votes, { weightOf: flat(1), blocked: new Set(['troll1', 'troll2']) });
  assert.equal(blocked.leader!.value, 10);
  assert.equal(blocked.verified, true);
  const invalid = tally(votes, { weightOf: flat(1), valid: (v) => v < 200 });
  assert.equal(invalid.total, 3);
  assert.equal(invalid.verified, true);
  assert.equal(tally([vote('t', 500)], { weightOf: flat(1), valid: () => false }).leader, undefined);
});

test('season states from room proposals: per field, validated, mine flagged, unknown seasons skipped', () => {
  const p = (author: string, extra: Partial<MappingProposal>): MappingProposal => ({ season: 's2', field: 'end', to: 88, author, ts: 10, ...extra });
  const proposals: MappingProposal[] = [
    p('a', {}),
    p('b', {}),
    p('c', {}),
    p('me', { to: 90, ts: 11 }),
    p('a', { field: 'ep', ep: 1, from: 58, to: 60 }),
    p('x', { to: 20 }), // before the season start: invalid
    p('a', { season: 'other', to: 5 }),
  ];
  const ctx = { episodes: 12, after: 57, afterReliable: true, priorEpisodes: 24, knownTotal: 142 };
  const states = computeSeasonStates(proposals, {
    contexts: { s2: ctx, empty: ctx },
    weightOf: flat(0.7),
    me: 'me',
  });
  assert.deepEqual(Object.keys(states).sort(), ['empty', 's2']);
  assert.equal(states.empty, undefined);
  const s2 = states.s2!;
  assert.equal(s2.end!.to, 88);
  assert.equal(s2.end!.confirmations, 3);
  assert.equal(s2.end!.verified, true);
  assert.equal(s2.end!.mine, '90');
  assert.deepEqual(s2.eps![1], { from: 58, to: 60, confirmations: 1, verified: false });
});
