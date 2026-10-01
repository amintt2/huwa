/// <reference types="node" />
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { cancelPendingWrites, debouncedWriter, flushPendingWrites, hydrationGate, leavesForeground } from '../persist';

test('a debounced write runs once after the delay', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let writes = 0;
    const w = debouncedWriter(async () => void writes++, 400);
    w.schedule();
    w.schedule();
    mock.timers.tick(399);
    assert.equal(writes, 0);
    mock.timers.tick(1);
    await w.flush();
    assert.equal(writes, 1);
    assert.equal(w.pending(), false);
  } finally {
    mock.timers.reset();
  }
});

test('flushPendingWrites writes pending changes right away (app going to background)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const saved: string[] = [];
    let value = 'a';
    const w = debouncedWriter(async () => void saved.push(value), 400);
    w.schedule();
    value = 'b';
    await flushPendingWrites();
    assert.deepEqual(saved, ['b'], 'the latest state is written, once');
    mock.timers.tick(1000);
    await flushPendingWrites();
    assert.deepEqual(saved, ['b'], 'the cancelled timer does not write again');
  } finally {
    mock.timers.reset();
  }
});

test('writes stay ordered and a failed write does not block the next ones', async () => {
  const order: number[] = [];
  let n = 0;
  const w = debouncedWriter(async () => {
    const mine = ++n;
    if (mine === 1) {
      await new Promise((r) => setImmediate(r));
      order.push(mine);
      throw new Error('disk full');
    }
    order.push(mine);
  }, 10_000);
  w.schedule();
  const first = w.flush();
  w.schedule();
  await w.flush();
  await first;
  assert.deepEqual(order, [1, 2]);
});

test('cancelPendingWrites drops pending writes', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let writes = 0;
    const w = debouncedWriter(async () => void writes++, 400);
    w.schedule();
    cancelPendingWrites();
    mock.timers.tick(1000);
    await flushPendingWrites();
    assert.equal(writes, 0);
  } finally {
    mock.timers.reset();
  }
});

test('hydration gate: early patches survive the late load and are persisted after it', () => {
  type P = { rate: number; lang: string; autoNext: boolean };
  const gate = hydrationGate<P>();
  assert.equal(gate.patch({ autoNext: false }), false, 'not written before hydration');
  const { value, dirty } = gate.settle({ rate: 1.5, lang: 'en', autoNext: true });
  assert.deepEqual(value, { rate: 1.5, lang: 'en', autoNext: false });
  assert.equal(dirty, true);
  assert.equal(gate.patch({ rate: 2 }), true, 'written normally once hydrated');
  assert.equal(gate.settle({ rate: 1, lang: 'fr', autoNext: true }).dirty, false);
});

test('only background / inactive trigger a flush', () => {
  assert.equal(leavesForeground('background'), true);
  assert.equal(leavesForeground('inactive'), true);
  assert.equal(leavesForeground('active'), false);
});
