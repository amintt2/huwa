/// <reference types="node" />
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import type { Label } from '../../p2p/contract';
import {
  fingerprint,
  isValidPhrase,
  normalizePhraseInput,
  phraseFromEntropy,
  pickVerifyIndices,
  rootKeysFromPhrase,
  sign,
  unknownWords,
  verify,
} from '../identity';
import { activeLabels, hiddenAuthors, matchesWords, moderate } from '../moderation';
import { reputation, weightedVotes } from '../reputation';

// ---------- identity ----------

test('phrase round trip and deterministic keys', () => {
  const words = phraseFromEntropy(new Uint8Array(randomBytes(32)));
  assert.equal(words.length, 24);
  assert.ok(isValidPhrase(words));
  const a = rootKeysFromPhrase(words);
  const b = rootKeysFromPhrase(normalizePhraseInput(words.map((w, i) => `${i + 1}. ${w.toUpperCase()}`).join('\n')));
  assert.equal(a.publicKey, b.publicKey);
  assert.match(a.publicKey, /^[0-9a-f]{64}$/);
});

test('invalid phrase rejected', () => {
  const words = phraseFromEntropy(new Uint8Array(32));
  const swapped = [...words];
  [swapped[0], swapped[1]] = ['zoo', 'zoo'];
  assert.equal(isValidPhrase(swapped), false);
  assert.throws(() => rootKeysFromPhrase(words.slice(0, 12)));
  assert.deepEqual(unknownWords(['abandon', 'pomme']), [1]);
});

test('sign / verify', () => {
  const k = rootKeysFromPhrase(phraseFromEntropy(new Uint8Array(randomBytes(32))));
  const sig = sign('bonjour', k.secretKey);
  assert.ok(verify('bonjour', sig, k.publicKey));
  assert.equal(verify('bonjour!', sig, k.publicKey), false);
  assert.equal(verify('bonjour', 'zz', k.publicKey), false);
});

test('fingerprint shape and verify indices', () => {
  assert.match(fingerprint('a'.repeat(64)), /^[a-z0-9]{4}·[a-z0-9]{4}$/);
  assert.notEqual(fingerprint('a'.repeat(64)), fingerprint('b'.repeat(64)));
  const idx = pickVerifyIndices(new Uint8Array([5, 5, 5, 5]));
  assert.equal(new Set(idx).size, 3);
  assert.ok(idx.every((i) => i >= 0 && i < 24));
});

// ---------- moderation ----------

const ME = 'me';
const L = (by: string, target: string, val: Label['val'], ts = 1, neg?: boolean): Label => ({ by, target, val, ts, neg });

test('2 subscriptions blocking A hide A; one is not enough', () => {
  const labels = [L('s1', 'A', 'hide'), L('s2', 'A', 'hide'), L('s1', 'B', 'hide')];
  const hidden = hiddenAuthors({ me: ME, labels, subscriptions: ['s1', 's2'] });
  assert.ok(hidden.has('A'));
  assert.ok(!hidden.has('B'));
});

test('labels from non-subscribed keys are ignored, and I am never hidden', () => {
  const labels = [L('x', 'A', 'hide'), L('y', 'A', 'hide'), L('s1', ME, 'hide'), L('s2', ME, 'hide')];
  const hidden = hiddenAuthors({ me: ME, labels, subscriptions: ['s1', 's2'] });
  assert.ok(!hidden.has('A'));
  assert.ok(!hidden.has(ME));
});

test('negation retracts the latest label', () => {
  const labels = [L(ME, 'A', 'hide', 1), L(ME, 'A', 'hide', 2, true)];
  assert.equal(activeLabels(labels).length, 0);
  assert.ok(!hiddenAuthors({ me: ME, labels, subscriptions: [] }).has('A'));
});

test('word filter ignores case and accents, matches whole words', () => {
  assert.equal(matchesWords('Quel SPÖILER !', ['spoiler']), 'spoiler');
  assert.equal(matchesWords('spoilers', ['spoiler']), undefined);
  assert.equal(matchesWords('la fin de la saison', ['fin de la saison']), 'fin de la saison');
});

test('moderate() verdicts', () => {
  const items = [
    { id: '1', author: 'blocked', text: 'hey' },
    { id: '2', author: 'ok', text: 'le tueur est Bob' },
    { id: '3', author: 'ok', text: 'hello' },
    { id: '4', author: ME, text: 'tueur' },
    { id: '5', author: 'ok', text: 'report me' },
  ];
  const v = moderate(items, {
    me: ME,
    labels: [L(ME, 'blocked', 'hide'), L('s1', '3', 'spoiler'), L(ME, '5', 'spam')],
    subscriptions: ['s1'],
    words: ['tueur'],
  });
  assert.equal(v.get('1')?.reason, 'bloqué');
  assert.equal(v.get('2')?.reason, 'mot');
  assert.deepEqual(v.get('3'), { hidden: false, spoiler: true });
  assert.equal(v.get('4')?.hidden, false);
  assert.equal(v.get('5')?.reason, 'signalé');
});

// ---------- reputation ----------

test('2-hop trust: unreachable keys weigh 0', () => {
  const rep = reputation(ME, {
    me: { follows: ['a', 'b'] },
    a: { follows: ['c'] },
    b: { follows: ['c', 'd'] },
    sybil1: { follows: ['sybil2'] },
    sybil2: { follows: ['sybil1'] },
  });
  assert.ok(rep.a > rep.d);
  // c is vouched for by both of my follows, d by one only.
  assert.ok(rep.c > rep.d);
  assert.equal(rep.sybil1 ?? 0, 0);
  assert.ok(weightedVotes(['sybil1', 'sybil2'], rep) < weightedVotes(['a'], rep));
});

test('my blocks zero a key, follows blocking dampen it', () => {
  const rep = reputation(ME, {
    me: { follows: ['a', 'b'], blocks: ['x'] },
    a: { follows: ['x', 'y'], blocks: ['y'] },
    b: { follows: ['y'] },
  });
  assert.equal(rep.x, 0);
  const undamped = reputation(ME, { me: { follows: ['a', 'b'] }, a: { follows: ['x', 'y'] }, b: { follows: ['y'] } });
  assert.ok(rep.y < undamped.y);
});
