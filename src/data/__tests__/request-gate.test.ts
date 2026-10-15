/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cooldownFromResponse, createRequestGate, RateLimitedError } from '../request-gate';

const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k] ?? null });

test('dedupe: identical requests in flight share one call', async () => {
  const gate = createRequestGate();
  let calls = 0;
  let release!: (v: number) => void;
  const task = () => {
    calls++;
    return new Promise<number>((r) => (release = r));
  };
  const a = gate.dedupe('q', task);
  const b = gate.dedupe('q', task);
  assert.equal(calls, 1);
  release(7);
  assert.deepEqual(await Promise.all([a, b]), [7, 7]);
  await gate.dedupe('q', async () => (calls++, 8));
  assert.equal(calls, 2, 'settled: the next one is a new request');
});

test('concurrency: at most maxConcurrent tasks run at once', async () => {
  const gate = createRequestGate({ maxConcurrent: 2 });
  let running = 0;
  let peak = 0;
  const task = async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
  };
  await Promise.all(Array.from({ length: 6 }, () => gate.run(task)));
  assert.equal(peak, 2);
});

test('backoff: requests wait for a short cooldown, fail fast on a long one', async () => {
  let t = 0;
  const slept: number[] = [];
  const gate = createRequestGate({
    maxWait: 10_000,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  });
  gate.backoff(3000);
  assert.equal(await gate.run(async () => 'ok'), 'ok');
  assert.deepEqual(slept, [3000]);
  gate.backoff(60_000);
  await assert.rejects(gate.run(async () => 'never'), RateLimitedError);
  // A shorter backoff never shortens a longer one already set.
  gate.backoff(1000);
  assert.equal(gate.cooldown(), 60_000);
});

test('cooldownFromResponse: Retry-After, rate-limit headers, defaults', () => {
  const now = 1_700_000_000_000;
  assert.equal(cooldownFromResponse(429, headers({ 'Retry-After': '30' }), now), 30_000);
  assert.equal(cooldownFromResponse(429, headers({ 'Retry-After': new Date(now + 5000).toUTCString() }), now), 5000);
  assert.equal(cooldownFromResponse(429, headers({ 'X-RateLimit-Reset': String(now / 1000 + 12) }), now), 12_000);
  assert.equal(cooldownFromResponse(429, headers({}), now), 60_000);
  assert.equal(cooldownFromResponse(200, headers({ 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(now / 1000 + 20) }), now), 20_000);
  assert.equal(cooldownFromResponse(200, headers({ 'X-RateLimit-Remaining': '42' }), now), 0);
  assert.equal(cooldownFromResponse(200, headers({}), now), 0);
});
