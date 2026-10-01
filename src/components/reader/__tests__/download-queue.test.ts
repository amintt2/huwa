/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bySeries, isStaleCopy, nextChapters, nextToStart, reduce, type Downloads, type QueueEvent } from '../download-queue';

const run = (events: QueueEvent[], s: Downloads = {}) => events.reduce(reduce, s);
const enq = (chapterId: string, seriesId = 's', at = 1): QueueEvent => ({ type: 'enqueue', chapterId, seriesId, at });

test('happy path: queued → downloading → done', () => {
  const s = run([enq('c1'), { type: 'start', chapterId: 'c1' }, { type: 'pages', chapterId: 'c1', files: ['0.jpg', '1.jpg'] }, { type: 'progress', chapterId: 'c1', saved: 1 }]);
  assert.equal(s.c1.status, 'downloading');
  assert.equal(s.c1.total, 2);
  assert.equal(s.c1.saved, 1);
  const done = reduce(s, { type: 'done', chapterId: 'c1', bytes: 1234 });
  assert.equal(done.c1.status, 'done');
  assert.equal(done.c1.saved, 2);
  assert.equal(done.c1.bytes, 1234);
});

test('enqueue is idempotent and keeps the queue order', () => {
  const s = run([enq('c1'), enq('c2'), enq('c1')]);
  assert.deepEqual(Object.values(s).map((e) => [e.chapterId, e.order]), [['c1', 1], ['c2', 2]]);
  const done = run([{ type: 'start', chapterId: 'c1' }, { type: 'done', chapterId: 'c1', bytes: 1 }, enq('c1')], s);
  assert.equal(done.c1.status, 'done', 'a downloaded chapter is not queued again');
});

test('pause / resume / fail / retry', () => {
  let s = run([enq('c1'), { type: 'start', chapterId: 'c1' }, { type: 'pause', chapterId: 'c1' }]);
  assert.equal(s.c1.status, 'paused');
  s = reduce(s, { type: 'progress', chapterId: 'c1', saved: 5 });
  assert.equal(s.c1.saved, 0, 'late progress of an aborted download is ignored');
  s = reduce(s, { type: 'fail', chapterId: 'c1', error: 'Annulé' });
  assert.equal(s.c1.status, 'paused', 'abort error after a pause does not turn it into an error');
  s = run([{ type: 'resume', chapterId: 'c1' }, { type: 'start', chapterId: 'c1' }, { type: 'fail', chapterId: 'c1', error: 'HTTP 503' }], s);
  assert.equal(s.c1.status, 'error');
  assert.equal(s.c1.error, 'HTTP 503');
  s = reduce(s, enq('c1'));
  assert.equal(s.c1.status, 'queued', 'enqueue again retries');
  assert.equal(s.c1.error, undefined);
});

test('pauseAll / resumeAll only touch active / paused entries', () => {
  let s = run([enq('a'), enq('b'), enq('c'), { type: 'start', chapterId: 'a' }, { type: 'done', chapterId: 'a', bytes: 1 }, { type: 'start', chapterId: 'b' }]);
  s = reduce(s, { type: 'pauseAll' });
  assert.deepEqual([s.a.status, s.b.status, s.c.status], ['done', 'paused', 'paused']);
  s = reduce(s, { type: 'resumeAll' });
  assert.deepEqual([s.a.status, s.b.status, s.c.status], ['done', 'queued', 'queued']);
});

test('remove and removeSeries', () => {
  const s = run([enq('a', 'x'), enq('b', 'y'), enq('c', 'x')]);
  assert.deepEqual(Object.keys(reduce(s, { type: 'remove', chapterId: 'a' })), ['b', 'c']);
  assert.deepEqual(Object.keys(reduce(s, { type: 'removeSeries', seriesId: 'x' })), ['b']);
});

test('restore: interrupted downloads are queued again, saved state never overrides live state', () => {
  const live = run([enq('a')]);
  const saved = run([enq('a'), enq('b'), { type: 'start', chapterId: 'b' }, enq('c'), { type: 'start', chapterId: 'c' }, { type: 'done', chapterId: 'c', bytes: 9 }]);
  saved.a.status = 'done';
  const s = reduce(live, { type: 'restore', saved });
  assert.equal(s.a.status, 'queued');
  assert.equal(s.b.status, 'queued');
  assert.equal(s.c.status, 'done');
});

test('scheduler: free slots, queue order, network policy', () => {
  const s = run([enq('a'), enq('b'), enq('c'), enq('d'), { type: 'start', chapterId: 'b' }]);
  assert.deepEqual(nextToStart(s, { concurrency: 2, allowed: true }), ['a']);
  assert.deepEqual(nextToStart(s, { concurrency: 3, allowed: true }), ['a', 'c']);
  assert.deepEqual(nextToStart(s, { concurrency: 3, allowed: false }), [], 'Wi-Fi only on cellular: nothing starts');
});

test('grouped by series with storage', () => {
  const s = run([enq('a', 'x', 1), enq('b', 'y', 5), enq('c', 'x', 3), { type: 'start', chapterId: 'a' }, { type: 'done', chapterId: 'a', bytes: 100 }, { type: 'pause', chapterId: 'c' }]);
  const groups = bySeries(s);
  assert.deepEqual(groups.map((g) => g.seriesId), ['y', 'x']);
  assert.deepEqual([groups[1].done, groups[1].paused, groups[1].bytes], [1, 1, 100]);
  assert.equal(groups[0].active, 1);
});

test('next chapters to fetch', () => {
  const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
  const s = run([enq('c3'), { type: 'start', chapterId: 'c3' }, { type: 'done', chapterId: 'c3', bytes: 1 }]);
  assert.deepEqual(nextChapters(ids, 'c1', 3, s), ['c2', 'c4', 'c5'], 'skips downloaded ones');
  assert.deepEqual(nextChapters(ids, 'c5', 3, s), ['c6']);
  assert.deepEqual(nextChapters(ids, 'c2', 2, s, { includeFrom: true }), ['c2', 'c4']);
  assert.deepEqual(nextChapters(ids, null, 2, s), ['c1', 'c2'], 'from the start');
  assert.deepEqual(nextChapters(ids, 'zz', 2, s), [], 'unknown chapter: nothing');
});

test('provenance: stored with the pages, a copy of another mapping is stale', () => {
  const s = run([enq('c1'), { type: 'start', chapterId: 'c1' }, { type: 'pages', chapterId: 'c1', files: ['0.jpg'], provenance: 'mangadex|m1|ch-fr|fr' }, { type: 'done', chapterId: 'c1', bytes: 1 }]);
  assert.equal(s.c1.provenance, 'mangadex|m1|ch-fr|fr');
  assert.equal(isStaleCopy(s.c1, 'mangadex|m1|ch-fr|fr'), false);
  assert.equal(isStaleCopy(s.c1, 'mangadex|m1|ch-en|en'), true, 'language switched');
  assert.equal(isStaleCopy(s.c1, undefined), false, 'mapping unknown (offline, source not loaded): keep the copy');
  assert.equal(isStaleCopy({}, 'x'), false, 'entries from before provenance existed');
});
