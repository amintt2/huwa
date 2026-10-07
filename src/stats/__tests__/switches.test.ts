/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { summarizeSwitches, type SwitchEvent } from '../model';

const ev = (o: Partial<SwitchEvent>): SwitchEvent => ({
  at: 1,
  reason: 'stall',
  mode: 'hard',
  fromKind: 'http',
  fromRes: 1080,
  stallsBefore: 3,
  stalledMsBefore: 6000,
  ...o,
});

test('switch stats: counts per reason, seamless share, stalls per minute before / after', () => {
  const s = summarizeSwitches([
    ev({ stallsAfter: 0, stalledMsAfter: 0, afterMs: 120_000, tSwitch: 1800 }),
    ev({ reason: 'weak-swarm', fromKind: 'torrent', stallsBefore: 6, stallsAfter: 4, afterMs: 120_000, tSwitch: 2400 }),
    ev({ reason: 'upgrade', mode: 'seamless', stallsBefore: 0, stallsAfter: 0, afterMs: 120_000, tSwitch: 0 }),
    ev({ reason: 'wrong-duration', mode: 'drop' }),
    ev({ stallsAfter: 1, afterMs: 10_000 }), // window too short: not measured
  ]);
  assert.equal(s.total, 5);
  assert.deepEqual(s.byReason, { stall: 2, 'weak-swarm': 1, upgrade: 1, 'wrong-duration': 1 });
  assert.equal(s.seamless, 1);
  assert.equal(s.measured, 3);
  // Stability switches: 3 → 0 helped, 6/1.5=4 → 2/min helped.
  assert.equal(s.helped, 1);
  assert.equal(s.tSwitch, 1800);
  assert.ok((s.stallsPerMinAfter ?? 9) < (s.stallsPerMinBefore ?? 0));
});

test('switch stats: empty', () => {
  const s = summarizeSwitches([]);
  assert.equal(s.total, 0);
  assert.equal(s.helped, undefined);
});
