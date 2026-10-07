/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { summarizeDubs, type DubEvent } from '../model';

test('dub outcomes: hit rate over starts, track misses aside', () => {
  const at = 1;
  const list: DubEvent[] = [
    { at, outcome: 'hit', verified: true, ms: 1800 },
    { at, outcome: 'hit', ms: 2600 },
    { at, outcome: 'fallback', ms: 9000 },
    { at, outcome: 'refused' },
    { at, outcome: 'track-miss' },
  ];
  const s = summarizeDubs(list);
  assert.equal(s.starts, 4);
  assert.equal(s.hitRate, 0.5);
  assert.equal(s.counts['track-miss'], 1);
  assert.equal(s.hitMs, 2200);
  assert.equal(summarizeDubs([]).hitRate, undefined);
});
