/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { migrateLegacy, parseUnitId, seriesOfTarget } from '../migrate';
import { rateWait } from '../rate';

test('parse ids', () => {
  assert.deepEqual(parseUnitId('101922-e12'), { work: '101922', type: 'ep', unit: 12 });
  assert.deepEqual(parseUnitId('x-c3'), { work: 'x', type: 'ch', unit: 3 });
  assert.equal(parseUnitId('nope'), undefined);
  assert.equal(seriesOfTarget('ch:42-c7'), '42');
  assert.equal(seriesOfTarget('series:42'), '42');
});

test('legacy store migrates without loss', () => {
  const legacy = {
    userName: 'tahar',
    episodes: { '1-e1': { done: true, updatedAt: 30 }, '1-e2': { done: false, updatedAt: 40 } },
    chapters: { '1-c5': { done: true, updatedAt: 10 } },
    comments: [
      { id: 'u-1', target: 'ep:1-e1', author: 'tahar', text: 'wow', createdAt: 20, likes: 0, spoiler: true, timestamp: 12 },
      { id: 'u-2', target: 'ch:1-c5', parentId: 's-ch:1-c5-0', author: 'old', text: 'ok', createdAt: 50, likes: 2, spoiler: false },
    ],
    liked: { 's-ep:1-e1-0': true as const },
  };
  const m = migrateLegacy(legacy, { key: 'K', name: 'tahar' });
  assert.equal(m.comments.length, 2);
  assert.ok(m.comments.every((c) => c.author === 'K'));
  assert.equal(m.comments[0].timestamp, 12);
  assert.equal(m.comments[0].spoiler, true);
  assert.equal(m.comments[1].parentId, 's-ch:1-c5-0');
  assert.equal(m.comments[1].authorName, 'old');
  assert.deepEqual(m.likes, { 's-ep:1-e1-0': true });
  assert.deepEqual(
    m.journal.map((e) => [e.type, e.ts]),
    [
      ['ch', 10],
      ['comment', 20],
      ['ep', 30],
      ['comment', 50],
    ],
  );
});

test('empty legacy state', () => {
  assert.deepEqual(migrateLegacy({}, { key: 'K', name: 'n' }), { comments: [], likes: {}, journal: [] });
});

// ---------- posting rate ----------

test('rate: 15 s between messages, 30 per hour', () => {
  assert.equal(rateWait([], 1000), 0);
  assert.equal(rateWait([0], 10_000), 5_000);
  assert.equal(rateWait([0], 15_000), 0);
  const hour = Array.from({ length: 30 }, (_, i) => i * 60_000);
  assert.equal(rateWait(hour, 30 * 60_000), 30 * 60_000);
});
