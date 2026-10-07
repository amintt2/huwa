/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PlaybackMonitor, SEEK_GRACE_MS } from '../playback-monitor';

function clock() {
  let t = 1000;
  return { now: () => t, go: (ms: number) => (t += ms) };
}

test('stalls are counted after the first frame only, with their length', () => {
  const c = clock();
  const m = new PlaybackMonitor(c.now);
  m.reset('u');
  m.setLoading(true);
  c.go(2000);
  m.setLoading(false);
  assert.equal(m.snapshot().stalls.length, 0, 'opening is not a stall');
  m.firstFrame();
  c.go(10_000);
  m.setLoading(true);
  c.go(1500);
  assert.equal(m.snapshot().stalledNowMs, 1500);
  assert.equal(m.snapshot().stalls[0].ms, 1500, 'the ongoing stall counts');
  c.go(500);
  m.setLoading(false);
  const s = m.snapshot();
  assert.equal(s.stalls.length, 1);
  assert.equal(s.stalls[0].ms, 2000);
  assert.equal(s.stalledNowMs, 0);
});

test('a user seek is not a stall', () => {
  const c = clock();
  const m = new PlaybackMonitor(c.now);
  m.reset('u');
  m.firstFrame();
  c.go(5000);
  m.noteSeek();
  c.go(100);
  m.setLoading(true);
  c.go(1000);
  m.setLoading(false);
  assert.equal(m.snapshot().stalls.length, 0);
  c.go(SEEK_GRACE_MS);
  m.setLoading(true);
  assert.equal(m.snapshot().stalls.length, 1);
});

test('buffer ahead and its trend (draining)', () => {
  const c = clock();
  const m = new PlaybackMonitor(c.now);
  m.reset('u');
  m.firstFrame();
  for (let i = 0; i <= 12; i++) {
    m.progress(100 + i, 120 - i * 0.5); // playhead +1 s/s, buffered end +... shrinking ahead
    c.go(1000);
  }
  const s = m.snapshot();
  assert.ok(s.bufferAhead >= 0 && s.bufferAhead < 5);
  assert.ok(s.bufferTrend < -1, `trend ${s.bufferTrend}`);
});

test('a seamless swap starts the new source as already playing, stats from zero', () => {
  const c = clock();
  const m = new PlaybackMonitor(c.now);
  m.reset('a');
  m.firstFrame();
  m.setLoading(true);
  c.go(3000);
  m.setLoading(false);
  m.adopt('b');
  const s = m.snapshot();
  assert.equal(m.uri, 'b');
  assert.equal(s.started, true);
  assert.equal(s.stalls.length, 0);
});

test('torrent throughput in Mb/s, stalls since a moment', () => {
  const c = clock();
  const m = new PlaybackMonitor(c.now);
  m.reset('t');
  m.firstFrame();
  m.torrent(1_000_000, 1);
  assert.equal(m.snapshot().throughputMbps, 8);
  assert.equal(m.snapshot().peers, 1);
  const from = c.now();
  m.setLoading(true);
  c.go(700);
  m.setLoading(false);
  assert.deepEqual(m.stallsSince(from), { count: 1, ms: 700 });
});
