/// <reference types="node" />
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { cachedRace, clearRaceCache, fetchTransport, measureUrl, runPool, type Transport } from '../race-runner';

const opts = { bytes: 262144, timeoutMs: 2000 };

test('measureUrl caches per URL and deduplicates concurrent probes', async () => {
  clearRaceCache();
  let calls = 0;
  const t: Transport = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return { status: 206, bytes: 262144, contentType: 'video/mp4', ttfbMs: 100, totalMs: 200 };
  };
  const [a, b] = await Promise.all([measureUrl('https://x/1', undefined, opts, t), measureUrl('https://x/1', undefined, opts, t)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal((await measureUrl('https://x/1', undefined, opts, t))?.alive, true);
  assert.equal(calls, 1, 'served from the cache');
  assert.equal(cachedRace('https://x/1')?.alive, true);
});

test('a cancelled probe caches nothing', async () => {
  clearRaceCache();
  const ctrl = new AbortController();
  const t: Transport = async () => {
    ctrl.abort();
    return { status: 0, bytes: 0 };
  };
  assert.equal(await measureUrl('https://x/2', undefined, { ...opts, signal: ctrl.signal }, t), undefined);
  assert.equal(cachedRace('https://x/2'), undefined);
});

test('runPool never exceeds its concurrency and stops on abort', async () => {
  let active = 0;
  let peak = 0;
  const done: number[] = [];
  await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    done.push(n);
  });
  assert.equal(peak, 3);
  assert.equal(done.length, 7);

  const ctrl = new AbortController();
  const started: number[] = [];
  await runPool([1, 2, 3, 4], 1, async (n) => {
    started.push(n);
    if (n === 2) ctrl.abort();
  }, ctrl.signal);
  assert.deepEqual(started, [1, 2]);
});

// ---------- fetch transport against a local server ----------

let server: Server;
let base = '';
const FILE = Buffer.alloc(1 << 20, 7);

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/video') {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
      if (!m) return res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': FILE.length }).end(FILE);
      const [a, b] = [Number(m[1]), Math.min(Number(m[2]), FILE.length - 1)];
      res.writeHead(206, { 'content-type': 'application/force-download', 'content-range': `bytes ${a}-${b}/${FILE.length}` });
      return res.end(FILE.subarray(a, b + 1));
    }
    if (url === '/norange') return res.writeHead(200, { 'content-type': 'video/mp4' }).end(FILE);
    if (url === '/gone') return res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not found</h1>');
    if (url === '/page') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!DOCTYPE html><html></html>');
    if (url === '/redirect') return res.writeHead(302, { location: '/video' }).end();
    if (url === '/hang') return; // never answers
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test('fetch transport: ranged read with timings, redirects followed', async () => {
  for (const path of ['/video', '/redirect']) {
    const raw = await fetchTransport(base + path, undefined, opts);
    assert.equal(raw.status, 206, path);
    assert.equal(raw.bytes, 262144);
    assert.ok(raw.ttfbMs! >= 0 && raw.totalMs! >= raw.ttfbMs!);
    assert.equal(raw.contentRange, `bytes 0-262143/${FILE.length}`);
  }
});

test('fetch transport + verdicts: dead links, Range ignored, timeout', async () => {
  clearRaceCache();
  const m = (p: string, timeoutMs = 2000) => measureUrl(base + p, undefined, { ...opts, timeoutMs }, fetchTransport);
  assert.equal((await m('/gone'))?.dead, 'http');
  assert.equal((await m('/page'))?.dead, 'not-media');
  const norange = await m('/norange');
  assert.equal(norange?.alive, true);
  assert.equal(norange?.ranged, false);
  assert.equal(norange?.mbps, undefined);
  const hang = await m('/hang', 300);
  assert.equal(hang?.dead, 'timeout');
  const ok = await m('/video');
  assert.equal(ok?.alive, true);
  assert.equal(ok?.size, FILE.length);
  assert.ok(ok?.mbps && ok.mbps > 0);
});

test('a shared probe survives the first caller giving up (pre-search → watch handover)', async () => {
  clearRaceCache();
  let release!: () => void;
  let aborted = false;
  const transport: Transport = (_u, _h, o) =>
    new Promise((resolve) => {
      o.signal?.addEventListener('abort', () => (aborted = true));
      release = () => resolve({ status: 206, contentType: 'video/mp4', contentRange: 'bytes 0-99/1000', bytes: 100_000, ttfbMs: 50, totalMs: 120 });
    });
  const a = new AbortController();
  const b = new AbortController();
  const first = measureUrl('https://x.test/v.mp4', undefined, { bytes: 1, timeoutMs: 1000, signal: a.signal }, transport);
  const second = measureUrl('https://x.test/v.mp4', undefined, { bytes: 1, timeoutMs: 1000, signal: b.signal }, transport);
  a.abort();
  assert.equal(await first, undefined);
  assert.equal(aborted, false, 'still one waiter: the request must go on');
  release();
  const r = await second;
  assert.equal(r?.alive, true);
});

test('the shared probe is cancelled once every caller gave up', async () => {
  clearRaceCache();
  let aborted = false;
  const transport: Transport = (_u, _h, o) =>
    new Promise(() => {
      o.signal?.addEventListener('abort', () => (aborted = true));
    });
  const a = new AbortController();
  const b = new AbortController();
  void measureUrl('https://x.test/w.mp4', undefined, { bytes: 1, timeoutMs: 1000, signal: a.signal }, transport);
  void measureUrl('https://x.test/w.mp4', undefined, { bytes: 1, timeoutMs: 1000, signal: b.signal }, transport);
  a.abort();
  b.abort();
  assert.equal(aborted, true);
});
