/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CommentFlag, FlagReason } from '../../p2p/contract';
import { communityVerdicts, latestFlags, LABEL_OF, FLAG_REASONS, isFlagReason } from '../community';
import { authorWeight } from '../consensus';

const f = (author: string, comment = 'c1', reason: FlagReason = 'abuse', ts = 1): CommentFlag => ({ author, comment, reason, ts });
const authorOf = (id: string) => ({ c1: 'troll', c2: 'nice' })[id];
const flat = (w: number) => () => w;

test('reasons map to labels; validation', () => {
  assert.deepEqual(FLAG_REASONS.map((r) => r.val), ['spoiler', 'abuse', 'nsfw', 'spam', 'other']);
  assert.equal(LABEL_OF.other, 'hide');
  assert.ok(isFlagReason('nsfw'));
  assert.ok(!isFlagReason('hate'));
});

test('newest flag per author and comment', () => {
  const out = latestFlags([f('a', 'c1', 'spam', 1), f('a', 'c1', 'abuse', 2), f('a', 'c2', 'spam', 1)]);
  assert.deepEqual(out.map((x) => [x.comment, x.reason]).sort(), [['c1', 'abuse'], ['c2', 'spam']]);
});

test('collapse needs enough distinct, weighted authors', () => {
  const regulars = [f('a'), f('b'), f('c')];
  assert.equal(communityVerdicts(regulars, { weightOf: flat(0.5), authorOf }).get('c1')?.hidden, true);
  // Two people are not enough, however trusted.
  assert.equal(communityVerdicts(regulars.slice(0, 2), { weightOf: flat(1), authorOf }).get('c1')?.hidden, false);
  // Fifteen fresh identities (0.1 each) are not enough either.
  const sybils = Array.from({ length: 14 }, (_, i) => f(`s${i}`));
  assert.equal(communityVerdicts(sybils, { weightOf: () => authorWeight({}), authorOf }).get('c1')?.hidden, false);
  // Weights are capped at 1.
  assert.equal(communityVerdicts(regulars, { weightOf: flat(50), authorOf }).get('c1')?.weight, 3);
});

test('ignored: self-flags, blocked reporters, unknown comments, retracted flags', () => {
  const flags = [f('a'), f('b'), f('troll'), f('x', 'zz')];
  const v = communityVerdicts(flags, { weightOf: flat(1), authorOf });
  assert.equal(v.get('c1')?.authors, 2);
  assert.equal(v.has('zz'), false);
  const blocked = communityVerdicts([f('a'), f('b'), f('c')], { weightOf: flat(1), authorOf, blocked: new Set(['c']) });
  assert.equal(blocked.get('c1')?.hidden, false);
});

test('spoiler reports blur instead of collapsing; reasons ranked', () => {
  const v = communityVerdicts([f('a', 'c2', 'spoiler'), f('b', 'c2', 'spoiler'), f('c', 'c2', 'spam')], { weightOf: flat(0.6), authorOf }).get('c2')!;
  assert.equal(v.spoiler, true);
  assert.equal(v.hidden, false);
  assert.deepEqual(v.reasons, ['spoiler', 'spam']);
  const mixed = communityVerdicts([f('a', 'c1', 'nsfw'), f('b', 'c1', 'spam'), f('c', 'c1', 'abuse')], { weightOf: flat(0.6), authorOf }).get('c1')!;
  assert.equal(mixed.hidden, true);
  assert.equal(mixed.spoiler, false);
});

test('deterministic whatever the order', () => {
  const flags = [f('a', 'c1', 'spam', 3), f('b', 'c1', 'abuse', 1), f('a', 'c1', 'abuse', 3), f('c', 'c1', 'nsfw', 2)];
  const a = communityVerdicts(flags, { weightOf: flat(0.7), authorOf });
  const b = communityVerdicts([...flags].reverse(), { weightOf: flat(0.7), authorOf });
  assert.deepEqual([...a], [...b]);
});
