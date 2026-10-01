/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runPool } from '../pool';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('pool: a failure aborts the siblings and settles only once they all stopped', async () => {
  const started: number[] = [];
  let running = 0;
  let settledSiblings = 0;
  const task = async (i: number, signal: AbortSignal) => {
    started.push(i);
    running++;
    try {
      if (i === 1) {
        await tick(2);
        throw new Error('page 1 KO');
      }
      // A page download that only stops when aborted (and takes a moment to unwind).
      await new Promise<void>((_, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(new Error('aborted')), 10)));
    } finally {
      running--;
      if (i !== 1) settledSiblings++;
    }
  };
  await assert.rejects(runPool(10, 3, task), /page 1 KO/);
  assert.equal(running, 0, 'nothing still running when the pool rejects');
  assert.equal(settledSiblings, 2);
  assert.deepEqual(started.sort(), [0, 1, 2], 'no new page started after the failure');
});

test('pool: runs everything with bounded concurrency; parent abort stops it', async () => {
  let running = 0;
  let peak = 0;
  const done: number[] = [];
  await runPool(7, 3, async (i) => {
    running++;
    peak = Math.max(peak, running);
    await tick(1);
    running--;
    done.push(i);
  });
  assert.equal(peak, 3);
  assert.deepEqual(done.sort(), [0, 1, 2, 3, 4, 5, 6]);

  const parent = new AbortController();
  const p = runPool(5, 2, (_i, signal) => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), parent.signal);
  parent.abort();
  await assert.rejects(p, /aborted/);
  await runPool(0, 3, async () => assert.fail('no task'));
});
