/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSwrCache, hashKey, type SwrStorage } from '../swr-core';

/** In-memory AsyncStorage with call counters. */
function memStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  const calls = { get: 0, set: 0, remove: 0 };
  const storage: SwrStorage = {
    getItem: async (k) => {
      calls.get++;
      return map.has(k) ? map.get(k)! : null;
    },
    setItem: async (k, v) => {
      calls.set++;
      map.set(k, v);
    },
    removeItem: async (k) => {
      calls.remove++;
      map.delete(k);
    },
    getAllKeys: async () => [...map.keys()],
  };
  return { map, calls, storage };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const MIN = 60_000;
const make = (storage: SwrStorage, now: () => number, over: Partial<Parameters<typeof createSwrCache>[0]> = {}) =>
  createSwrCache({ storage, prefix: 'huwa/swr/', version: 1, maxEntries: 50, maxBytes: 1_000_000, now, ...over });

/** A fetcher that counts calls and returns the queued values in order. */
function fetcher<T>(...values: T[]) {
  let calls = 0;
  const fn = async () => {
    calls++;
    const v = values[Math.min(calls - 1, values.length - 1)];
    if (v instanceof Error) throw v;
    return v;
  };
  return Object.assign(fn, { calls: () => calls });
}

test('ttl: a fresh entry is served without the network, a stale one is shown then refreshed', async () => {
  const { storage } = memStorage();
  const c = clock();
  const cache = make(storage, c.now);
  const f = fetcher(['a'], ['b']);
  assert.deepEqual(await cache.swr('k', f, { ttl: 10 * MIN }), ['a']); // nothing cached: network
  assert.equal(f.calls(), 1);
  c.advance(5 * MIN);
  assert.deepEqual(await cache.swr('k', f, { ttl: 10 * MIN }), ['a']); // fresh: no request
  assert.equal(f.calls(), 1);
  c.advance(6 * MIN);
  // Stale: the cached value comes back at once, the refresh runs behind it.
  assert.deepEqual(await cache.swr('k', f, { ttl: 10 * MIN }), ['a']);
  assert.equal(f.calls(), 2);
  await cache.flush();
  assert.deepEqual(cache.peek('k')?.value, ['b']);
});

test('ttl: load() waits for fresh data when stale, falls back to the stale entry offline', async () => {
  const { storage } = memStorage();
  const c = clock();
  const cache = make(storage, c.now);
  await cache.set('k', 1);
  c.advance(20 * MIN);
  assert.equal(await cache.load('k', fetcher(2), { ttl: 10 * MIN }), 2);
  c.advance(20 * MIN);
  assert.equal(await cache.load('k', fetcher<number>(new Error('offline') as never), { ttl: 10 * MIN }), 2);
  // Too old to show even offline.
  c.advance(10 * 24 * 60 * MIN);
  await assert.rejects(cache.load('k', fetcher<number>(new Error('offline') as never), { ttl: 10 * MIN, maxStale: 24 * 60 * MIN }), /offline/);
});

test('ttl: beyond maxStale the cached value is not shown, the network is waited for', async () => {
  const { storage } = memStorage();
  const c = clock();
  const cache = make(storage, c.now);
  await cache.set('k', 'old');
  c.advance(3 * 24 * 60 * MIN);
  assert.equal(await cache.swr('k', fetcher('new'), { ttl: MIN, maxStale: 24 * 60 * MIN }), 'new');
});

test('persistence: entries survive a restart, a miss never reads the disk', async () => {
  const { storage, calls } = memStorage();
  const c = clock();
  const first = make(storage, c.now);
  await first.set('catalog', { list: [1, 2, 3] });
  await first.flush();

  const second = make(storage, c.now);
  await second.ready;
  const reads = calls.get;
  assert.equal(await second.get('unknown'), undefined);
  assert.equal(calls.get, reads, 'a key missing from the index is not read');
  assert.deepEqual((await second.get('catalog'))?.value, { list: [1, 2, 3] });
  assert.deepEqual(second.peek('catalog')?.value, { list: [1, 2, 3] }, 'kept in memory after the disk read');
});

test('versioning: a new version ignores and purges the entries of the old one', async () => {
  const { storage, map } = memStorage();
  const c = clock();
  const v1 = make(storage, c.now);
  await v1.set('catalog', 'v1 shape');
  await v1.flush();
  assert.ok([...map.keys()].some((k) => k.startsWith('huwa/swr/v1/')));

  const v2 = make(storage, c.now, { version: 2 });
  await v2.ready;
  assert.equal(await v2.get('catalog'), undefined);
  assert.ok(![...map.keys()].some((k) => k.startsWith('huwa/swr/v1/')), 'old version removed from storage');
  // Keys outside the prefix are never touched.
  map.set('huwa/settings/v1', '{}');
  const v3 = make(storage, c.now, { version: 3 });
  await v3.ready;
  assert.equal(map.get('huwa/settings/v1'), '{}');
});

test('versioning: a corrupted entry is dropped instead of crashing the screen', async () => {
  const { storage, map } = memStorage();
  const c = clock();
  const a = make(storage, c.now);
  await a.set('k', 'ok');
  await a.flush();
  map.set('huwa/swr/v1/e/k', '{not json');
  const b = make(storage, c.now);
  assert.equal(await b.get('k'), undefined);
  assert.equal(b.stats().entries, 0);
});

test('dedupe: concurrent refreshes of a key share one request', async () => {
  const { storage } = memStorage();
  const c = clock();
  const cache = make(storage, c.now);
  let calls = 0;
  let release!: (v: string) => void;
  const slow = () => {
    calls++;
    return new Promise<string>((r) => (release = r));
  };
  const a = cache.swr('k', slow, { ttl: MIN });
  const b = cache.swr('k', slow, { ttl: MIN });
  const d = cache.load('k', slow, { ttl: MIN });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 1);
  release('x');
  assert.deepEqual(await Promise.all([a, b, d]), ['x', 'x', 'x']);
  // Done: the next stale read asks again.
  c.advance(2 * MIN);
  await cache.load('k', async () => (calls++, 'y'), { ttl: MIN });
  assert.equal(calls, 2);
});

test('change detection: listeners hear only real changes', async () => {
  const { storage } = memStorage();
  const c = clock();
  const cache = make(storage, c.now);
  let heard = 0;
  cache.subscribe('k', () => heard++);
  assert.equal(await cache.set('k', { a: 1, b: [1, 2] }), true);
  const first = cache.state('k');
  assert.equal(heard, 1);
  // Same data from a refresh: no re-render, same snapshot object.
  c.advance(MIN);
  assert.equal(await cache.set('k', { a: 1, b: [1, 2] }), false);
  assert.equal(cache.state('k'), first);
  assert.equal(heard, 1);
  // The date still moved (no refresh right after).
  assert.equal(cache.peek('k')?.at, c.now());
  assert.equal(await cache.set('k', { a: 2, b: [1, 2] }), true);
  assert.equal(heard, 2);
  assert.notEqual(cache.state('k'), first);
});

test('state: pending and error are tracked per key, cleared by a success', async () => {
  const { storage } = memStorage();
  const c = clock();
  const cache = make(storage, c.now);
  const p = cache.revalidate('k', async () => {
    throw new Error('boom');
  });
  assert.equal(cache.state('k').pending, true);
  await assert.rejects(p);
  assert.equal(cache.state('k').pending, false);
  assert.match(String(cache.state('k').error), /boom/);
  await cache.revalidate('k', async () => 'ok');
  assert.equal(cache.state('k').error, undefined);
  assert.equal(cache.state('k').entry?.value, 'ok');
});

test('size cap: least recently used entries go first, by count and by bytes', async () => {
  const { storage, map } = memStorage();
  const c = clock();
  const cache = make(storage, c.now, { maxEntries: 3 });
  for (const k of ['a', 'b', 'c']) {
    await cache.set(k, k);
    c.advance(1000);
  }
  await cache.get('a'); // touched: now the most recently used
  c.advance(1000);
  await cache.set('d', 'd');
  await cache.flush();
  assert.equal(cache.stats().entries, 3);
  assert.equal(cache.peek('b'), undefined, 'b was the least recently used');
  assert.ok(!map.has('huwa/swr/v1/e/b'), 'removed from storage too');
  assert.ok(cache.peek('a') && cache.peek('c') && cache.peek('d'));

  const big = make(memStorage().storage, c.now, { maxBytes: 300 });
  await big.set('x', 'x'.repeat(100));
  c.advance(1000);
  await big.set('y', 'y'.repeat(100));
  c.advance(1000);
  await big.set('z', 'z'.repeat(100));
  assert.ok(big.stats().bytes <= 300);
  assert.equal(big.peek('x'), undefined);
  assert.ok(big.peek('z'));
});

test('size cap: an entry larger than the whole budget is kept in memory only', async () => {
  const { storage, map } = memStorage();
  const c = clock();
  const cache = make(storage, c.now, { maxBytes: 50 });
  await cache.set('small', 'ok');
  await cache.set('huge', 'h'.repeat(500));
  await cache.flush();
  assert.equal(cache.peek<string>('huge')?.value.length, 500);
  assert.ok(!map.has('huwa/swr/v1/e/huge'));
  // It does not push the others out either.
  assert.equal(cache.peek('small')?.value, 'ok');
  assert.equal(cache.stats().entries, 1);
});

test('clear: removes every entry of the cache', async () => {
  const { storage, map } = memStorage({ 'huwa/lists/v1': '[]' });
  const c = clock();
  const cache = make(storage, c.now);
  await cache.set('a', 1);
  await cache.set('b', 2);
  await cache.clear();
  assert.equal(cache.peek('a'), undefined);
  assert.equal(cache.stats().entries, 0);
  assert.deepEqual([...map.keys()].filter((k) => k.includes('/e/')), []);
  assert.equal(map.get('huwa/lists/v1'), '[]');
});

test('hashKey: stable, short, distinct for different inputs', () => {
  assert.equal(hashKey('https://addon/realdebrid=SECRET|series|top'), hashKey('https://addon/realdebrid=SECRET|series|top'));
  assert.notEqual(hashKey('a'), hashKey('b'));
  assert.ok(!hashKey('https://addon/realdebrid=SECRET').includes('SECRET'));
});
