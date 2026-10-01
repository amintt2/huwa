/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  autoNextEpisodes,
  evictionsFor,
  groupBySeries,
  MAX_ATTEMPTS,
  nextRetryIn,
  planEpisodes,
  reduce,
  startable,
  type Items,
  type NewDownload,
} from '../queue';

const nd = (n: number, extra: Partial<NewDownload> = {}): NewDownload => ({
  id: `s-e${n}`, seriesId: 's', episode: n, seriesTitle: 'Série', title: `Ép. ${n}`, durationMin: 24,
  quality: 'auto', wifiOnly: false, ...extra,
});
const src = { key: 'k', name: 'A', addonName: 'Addon', quality: 1080, url: 'https://x/v.mp4', ext: 'mp4' };

test('enqueue keeps batch order and skips what is already there', () => {
  let s: Items = {};
  s = reduce(s, { type: 'enqueue', items: [nd(1), nd(2)], now: 100 });
  assert.deepEqual(Object.keys(s), ['s-e1', 's-e2']);
  assert.ok(s['s-e1'].createdAt < s['s-e2'].createdAt);
  s = reduce(s, { type: 'complete', id: 's-e1', file: 'a.mp4', bytes: 10, now: 200 });
  s = reduce(s, { type: 'enqueue', items: [nd(1)], now: 300 });
  assert.equal(s['s-e1'].status, 'done');
});

test('lifecycle: queued → resolving → downloading → done', () => {
  let s = reduce({}, { type: 'enqueue', items: [nd(1)], now: 0 });
  s = reduce(s, { type: 'start', id: 's-e1' });
  assert.equal(s['s-e1'].status, 'resolving');
  s = reduce(s, { type: 'resolved', id: 's-e1', source: src, kind: 'file' });
  assert.equal(s['s-e1'].status, 'downloading');
  s = reduce(s, { type: 'progress', id: 's-e1', bytes: 50, total: 100 });
  assert.equal(s['s-e1'].bytes, 50);
  s = reduce(s, { type: 'complete', id: 's-e1', file: 'ep.mp4', bytes: 100, now: 5 });
  assert.equal(s['s-e1'].status, 'done');
  assert.equal(s['s-e1'].file, 'ep.mp4');
});

test('a source handed by the watch screen skips resolving', () => {
  let s = reduce({}, { type: 'enqueue', items: [nd(1, { source: src, kind: 'file' })], now: 0 });
  s = reduce(s, { type: 'start', id: 's-e1' });
  assert.equal(s['s-e1'].status, 'downloading');
});

test('retryable failures back off, then fail; expired links are forgotten', () => {
  let s = reduce({}, { type: 'enqueue', items: [nd(1, { source: src, kind: 'file' })], now: 0 });
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    s = reduce(s, { type: 'start', id: 's-e1' });
    s = reduce(s, { type: 'fail', id: 's-e1', error: 'HTTP 403', retryable: true, expired: true, now: 1000 });
    assert.equal(s['s-e1'].status, 'queued');
    assert.equal(s['s-e1'].source?.url, undefined);
    assert.ok(s['s-e1'].retryAt! > 1000);
    // Not before its backoff.
    assert.deepEqual(startable(s, { now: 1000, network: 'wifi', concurrency: 2 }), []);
    assert.deepEqual(startable(s, { now: s['s-e1'].retryAt!, network: 'wifi', concurrency: 2 }), ['s-e1']);
    assert.ok(nextRetryIn(s, 1000)! > 0);
  }
  s = reduce(s, { type: 'start', id: 's-e1' });
  s = reduce(s, { type: 'fail', id: 's-e1', error: 'HTTP 403', retryable: true, now: 9e9 });
  assert.equal(s['s-e1'].status, 'failed');
  // Manual retry: fresh attempts.
  s = reduce(s, { type: 'resume', id: 's-e1' });
  assert.equal(s['s-e1'].status, 'queued');
  assert.equal(s['s-e1'].attempts, 0);
});

test('pause / resume keeps the saved resume state', () => {
  let s = reduce({}, { type: 'enqueue', items: [nd(1, { source: src })], now: 0 });
  s = reduce(s, { type: 'start', id: 's-e1' });
  s = reduce(s, { type: 'pause', id: 's-e1', resume: '{"url":"x"}' });
  assert.equal(s['s-e1'].status, 'paused');
  assert.deepEqual(startable(s, { now: 0, network: 'wifi', concurrency: 2 }), []);
  s = reduce(s, { type: 'resume', id: 's-e1' });
  assert.equal(s['s-e1'].resume, '{"url":"x"}');
  assert.equal(s['s-e1'].status, 'queued');
});

test('Wi-Fi only waits for Wi-Fi; concurrency is respected', () => {
  let s = reduce({}, { type: 'enqueue', items: [nd(1, { wifiOnly: true }), nd(2), nd(3)], now: 0 });
  s = reduce(s, { type: 'network', network: 'cellular' });
  assert.equal(s['s-e1'].status, 'waiting-network');
  assert.deepEqual(startable(s, { now: 0, network: 'cellular', concurrency: 1 }), ['s-e2']);
  assert.deepEqual(startable(s, { now: 0, network: 'offline', concurrency: 3 }), []);
  s = reduce(s, { type: 'start', id: 's-e2' });
  assert.deepEqual(startable(s, { now: 0, network: 'cellular', concurrency: 1 }), []);
  s = reduce(s, { type: 'network', network: 'wifi' });
  assert.equal(s['s-e1'].status, 'queued');
  assert.deepEqual(startable(s, { now: 0, network: 'wifi', concurrency: 3 }), ['s-e1', 's-e3']);
});

test('restore after relaunch re-queues interrupted transfers', () => {
  let s = reduce({}, { type: 'enqueue', items: [nd(1)], now: 0 });
  s = reduce(s, { type: 'start', id: 's-e1' });
  s = reduce(s, { type: 'restore' });
  assert.equal(s['s-e1'].status, 'queued');
});

test('planEpisodes: one, next N, season', () => {
  const eps = [3, 1, 2, 4, 5].map((n) => ({ id: `s-e${n}`, number: n }));
  const items = reduce({}, { type: 'enqueue', items: [nd(3)], now: 0 });
  assert.deepEqual(planEpisodes(eps, 2, 'one', items), ['s-e2']);
  assert.deepEqual(planEpisodes(eps, 2, 'next', items, 3), ['s-e2', 's-e4']);
  assert.deepEqual(planEpisodes(eps, 1, 'season', items), ['s-e1', 's-e2', 's-e4', 's-e5']);
});

test('quota: watched downloads are evicted oldest first, never unwatched ones', () => {
  let s = reduce({}, { type: 'enqueue', items: [nd(1), nd(2), nd(3)], now: 0 });
  s = reduce(s, { type: 'complete', id: 's-e1', file: 'a', bytes: 400, now: 1 });
  s = reduce(s, { type: 'complete', id: 's-e2', file: 'b', bytes: 400, now: 2 });
  s = reduce(s, { type: 'complete', id: 's-e3', file: 'c', bytes: 400, now: 3 });
  const watched = (id: string) => id !== 's-e3';
  assert.deepEqual(evictionsFor(s, 2000, 300, watched), { evict: [], fits: true });
  assert.deepEqual(evictionsFor(s, 1300, 300, watched), { evict: ['s-e1'], fits: true });
  assert.deepEqual(evictionsFor(s, 600, 300, watched), { evict: ['s-e1', 's-e2'], fits: false });
});

test('auto next episode and grouping', () => {
  const eps = [1, 2, 3].map((n) => ({ id: `s-e${n}`, number: n }));
  const s = reduce({}, { type: 'enqueue', items: [nd(3)], now: 0 });
  assert.deepEqual(autoNextEpisodes([{ seriesId: 's', episodes: eps, lastWatched: 1 }], s), [{ seriesId: 's', id: 's-e2' }]);
  assert.deepEqual(autoNextEpisodes([{ seriesId: 's', episodes: eps, lastWatched: 2 }], s), []);
  assert.deepEqual(autoNextEpisodes([{ seriesId: 's', episodes: eps, lastWatched: null }], s), []);
  const g = groupBySeries(reduce(s, { type: 'enqueue', items: [nd(1)], now: 5 }));
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].items.map((i) => i.episode), [1, 3]);
});
