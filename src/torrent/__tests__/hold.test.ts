/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHolds, type Timers } from '../hold';

/** Manual clock + timers. */
function fakeTime() {
  let t = 1_000;
  let next = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set: (fn, ms) => {
      const id = next++;
      queue.set(id, { at: t + ms, fn });
      return id;
    },
    clear: (id) => {
      queue.delete(id as number);
    },
  };
  const advance = (ms: number) => {
    t += ms;
    for (const [id, q] of [...queue.entries()].sort((a, b) => a[1].at - b[1].at)) {
      if (q.at <= t && queue.has(id)) {
        queue.delete(id);
        q.fn();
      }
    }
  };
  return { timers, now: () => t, advance, pending: () => queue.size };
}

test('a torrent nobody holds any more is released after the delay, with the moment it was decided', () => {
  const clock = fakeTime();
  const released: [string, number][] = [];
  const holds = createHolds((h, at) => released.push([h, at]), { delayMs: 1500, now: clock.now, timers: clock.timers });
  holds.hold('a');
  clock.advance(10_000);
  assert.deepEqual(released, [], 'held: never released');
  holds.drop('a');
  const decided = clock.now();
  clock.advance(1499);
  assert.deepEqual(released, []);
  clock.advance(1);
  assert.deepEqual(released, [['a', decided]]);
  assert.equal(clock.pending(), 0);
});

test('a hand-over to another holder of the same torrent never releases it', () => {
  const clock = fakeTime();
  const released: string[] = [];
  const holds = createHolds((h) => released.push(h), { delayMs: 1500, now: clock.now, timers: clock.timers });
  // Pre-search pre-warm holds it, the tap's watch screen takes it over while the pre-search goes.
  holds.hold('pack');
  holds.drop('pack');
  clock.advance(800);
  holds.hold('pack');
  clock.advance(5_000);
  assert.deepEqual(released, []);
  // Two holders at once (pack episode + next-episode prefetch of the same pack): released only
  // when both are gone.
  holds.hold('pack');
  holds.drop('pack');
  clock.advance(5_000);
  assert.deepEqual(released, []);
  assert.equal(holds.holders('pack'), 1);
  holds.drop('pack');
  clock.advance(1500);
  assert.deepEqual(released, ['pack']);
});

test('switch storm: every abandoned torrent is released once, the current one never', () => {
  const clock = fakeTime();
  const released: string[] = [];
  const holds = createHolds((h) => released.push(h), { delayMs: 1500, now: clock.now, timers: clock.timers });
  const seq = Array.from({ length: 20 }, (_, i) => `t${i}`).concat('t0');
  let prev: string | null = null;
  for (const h of seq) {
    if (prev) holds.drop(prev);
    holds.hold(h);
    prev = h;
    clock.advance(2000);
  }
  // t0 was released after the first switch and taken again at the end: still held now.
  assert.equal(holds.holders('t0'), 1);
  assert.deepEqual(
    released,
    Array.from({ length: 20 }, (_, i) => `t${i}`),
    'each left torrent released once, in order',
  );
  assert.equal(clock.pending(), 0);
});
