/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { guessIntro } from '../aniskip';

const intro = (start: number, len = 89) => ({ kind: 'intro' as const, start, end: start + len });

test('no neighbour data → no guess', () => {
  assert.equal(guessIntro([[], []]), null);
});

test('neighbours agree on the start → start + length', () => {
  assert.deepEqual(guessIntro([[intro(120)], [intro(122)]]), { length: 89, start: 121 });
});

test('cold opens moving the opening → length only', () => {
  const g = guessIntro([[intro(0)], [intro(240, 90)], [intro(95, 88)]]);
  assert.equal(g?.start, null);
  assert.equal(g?.length, 89);
});

test('a single neighbour gives only the length', () => {
  assert.deepEqual(guessIntro([[intro(30)]]), { length: 89, start: null });
});
