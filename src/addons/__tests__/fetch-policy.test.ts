/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { firstUseful, isTransient, withRetry } from '../fetch-policy';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('transient failures: timeouts, network, 5xx, 408, 429; not other 4xx', () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(isTransient(abort), true);
  assert.equal(isTransient(new TypeError('Network request failed')), true);
  assert.equal(isTransient(new Error('HTTP 503')), true);
  assert.equal(isTransient(new Error('HTTP 429')), true);
  assert.equal(isTransient(new Error('HTTP 408')), true);
  assert.equal(isTransient(new Error('HTTP 404')), false);
  assert.equal(isTransient(new Error('HTTP 400')), false);
});

test('withRetry retries a transient failure once, after a backoff', async () => {
  let calls = 0;
  const t0 = Date.now();
  const v = await withRetry(async () => {
    calls++;
    if (calls === 1) throw new Error('HTTP 502');
    return 'ok';
  }, { backoffMs: 30 });
  assert.equal(v, 'ok');
  assert.equal(calls, 2);
  assert.ok(Date.now() - t0 >= 25, 'waited the backoff');
});

test('withRetry gives up after one retry, and never retries a 404', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls++;
    throw new Error('HTTP 500');
  }, { backoffMs: 1 }), /HTTP 500/);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(withRetry(async () => {
    calls++;
    throw new Error('HTTP 404');
  }, { backoffMs: 1 }), /HTTP 404/);
  assert.equal(calls, 1);
});

test('withRetry stops when cancelled', async () => {
  const ctrl = new AbortController();
  let calls = 0;
  const p = withRetry(async () => {
    calls++;
    throw new Error('HTTP 500');
  }, { backoffMs: 50, signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(p);
  assert.equal(calls, 1);
});

const useful = (x: string) => !x.startsWith('info');

test('firstUseful: two requests in flight, first useful answer wins, no request after it', async () => {
  const started: string[] = [];
  const extra: string[][] = [];
  const delays: Record<string, number> = { a: 40, b: 10, c: 5 };
  const answers: Record<string, string[]> = { a: ['a1'], b: ['b1'], c: ['c1'] };
  const r = await firstUseful(['a', 'b', 'c'], async (req) => {
    started.push(req);
    await wait(delays[req]);
    return answers[req];
  }, useful, { onExtra: (items) => extra.push(items) });
  assert.deepEqual(r, { items: ['b1'], index: 1 });
  await wait(60);
  assert.deepEqual(started, ['a', 'b'], 'c never asked');
  assert.deepEqual(extra, [['a1']], 'the slower useful answer still comes in');
});

test('firstUseful moves on when an answer has nothing useful', async () => {
  const started: string[] = [];
  const r = await firstUseful(['a', 'b', 'c'], async (req) => {
    started.push(req);
    await wait(5);
    return req === 'c' ? ['c1'] : ['info: nothing'];
  }, useful, { concurrency: 1 });
  assert.deepEqual(r, { items: ['c1'], index: 2 });
  assert.deepEqual(started, ['a', 'b', 'c']);
});

test('firstUseful: nothing useful → highest-priority answer; all failing → the error', async () => {
  const r = await firstUseful(['a', 'b'], async (req) => {
    if (req === 'a') throw new Error('HTTP 500');
    return ['info: none'];
  }, useful);
  assert.deepEqual(r, { items: ['info: none'], index: 1 });
  await assert.rejects(firstUseful(['a', 'b'], async () => {
    throw new Error('down');
  }, useful), /down/);
  assert.deepEqual(await firstUseful([], async () => ['x'], useful), { items: [], index: -1 });
});
