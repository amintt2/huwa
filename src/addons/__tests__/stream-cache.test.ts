/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { entriesToDrop, freshness, MAX_AGE_MS, readAnswer, REVALIDATE_MS, storageKey, writeAnswer } from '../stream-cache';

test('freshness: fresh, then stale (shown + refreshed), then expired', () => {
  const now = 1_000_000_000;
  assert.equal(freshness(now - 1000, now), 'fresh');
  assert.equal(freshness(now - REVALIDATE_MS + 1, now), 'fresh');
  assert.equal(freshness(now - REVALIDATE_MS, now), 'stale');
  assert.equal(freshness(now - MAX_AGE_MS + 1, now), 'stale');
  assert.equal(freshness(now - MAX_AGE_MS, now), 'expired');
  assert.equal(freshness(now + 60_000, now), 'expired', 'clock went back: do not trust it');
});

test('pruning drops expired entries, then the oldest beyond the limit', () => {
  const now = 1_000_000_000;
  const idx = { old: now - MAX_AGE_MS - 1, a: now - 3000, b: now - 2000, c: now - 1000 };
  assert.deepEqual(entriesToDrop(idx, now, 2), ['old', 'a']);
  assert.deepEqual(entriesToDrop(idx, now, 10), ['old']);
});

test('storage keys are short and stable', () => {
  const k = storageKey('stream|https://addon.example/very/long/config|series/tt1:1:1');
  assert.equal(k, storageKey('stream|https://addon.example/very/long/config|series/tt1:1:1'));
  assert.notEqual(k, storageKey('stream|https://addon.example/very/long/config|series/tt1:1:2'));
  assert.ok(k.length < 40);
});

test('answers round-trip through storage', async () => {
  await writeAnswer('stream|x|series/tt1:1:1', [{ url: 'https://v/1.mp4' }]);
  const hit = await readAnswer<{ url: string }>('stream|x|series/tt1:1:1');
  assert.deepEqual(hit?.items, [{ url: 'https://v/1.mp4' }]);
  assert.equal(freshness(hit!.at), 'fresh');
  assert.equal(await readAnswer('stream|x|series/tt1:1:2'), undefined);
});
