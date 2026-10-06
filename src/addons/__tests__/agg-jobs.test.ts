/// <reference types="node" />
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import type { InstalledAddon } from '../addon-store';
import { AGG_TIMING, aggregateBase, episodeInUse, type JobOptions, type JobSpec, obtainAggregate, resetAggregates } from '../agg-jobs';
import type { AddonRequest } from '../id-candidates';

type Item = { url?: string; name?: string };

const DEFAULTS = { ...AGG_TIMING };
const addon = (name: string): InstalledAddon => ({
  baseUrl: `https://${name}.addon.example.test/cfg`,
  enabled: true,
  manifest: { id: `test.${name}`, name, resources: ['stream'] },
});
const spec = (a: InstalledAddon, ids = ['kitsu:1:1']): JobSpec => ({ a, reqs: ids.map((id) => ({ type: 'series', id })) });
const opts: JobOptions<Item> = { useful: (s) => !!s.url, same: (x, y) => x.url === y.url };
const video = (n: string): Item => ({ url: `https://cdn.example.test/${n}.mp4` });
const info: Item = { name: '⏳ Scraping, try again in a moment' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await sleep(5);
  }
}

/** Loader recording each request; `answer` decides what the addon says. */
function recorder(answer: (a: InstalledAddon, req: AddonRequest, n: number) => Promise<Item[]> | Item[]) {
  const calls: string[] = [];
  const load = async (a: InstalledAddon, req: AddonRequest) => {
    calls.push(`${a.manifest.name}:${req.id}`);
    return answer(a, req, calls.filter((c) => c.startsWith(`${a.manifest.name}:`)).length);
  };
  return { calls, load, count: (name: string) => calls.filter((c) => c.startsWith(`${name}:`)).length };
}

const base = (ep = 1) => aggregateBase('stream', '', 'al1', ep);

beforeEach(() => {
  resetAggregates();
  Object.assign(AGG_TIMING, { releaseGraceMs: 20, failureBackoffMs: 80, emptyRecheckMs: 80, maxAutoRechecks: 2 });
});
afterEach(() => {
  Object.assign(AGG_TIMING, DEFAULTS);
});

test('adding an addon: the new set reuses the answers already known and only asks the new addon', async () => {
  const A = addon('A');
  const B = addon('B');
  const r = recorder((a) => [video(a.manifest.name)]);
  const before = obtainAggregate<Item>(base(), 'set1', 'stream', [spec(A)], opts);
  const release = before.retain(r.load);
  await until(() => before.getSnapshot().done === 1);

  const after = obtainAggregate<Item>(base(), 'set2', 'stream', [spec(A), spec(B)], opts);
  assert.notEqual(after, before, 'a new set never gets the old aggregate');
  // Shown at once: no flash of "searching" for the addons that already answered.
  assert.equal(after.getSnapshot().done, 1);
  assert.deepEqual(after.getSnapshot().items, [video('A')]);

  const release2 = after.retain(r.load);
  release();
  await until(() => after.getSnapshot().done === 2);
  assert.equal(r.count('A'), 1, 'A is not asked again');
  assert.equal(r.count('B'), 1);
  assert.deepEqual(after.getSnapshot().items, [video('A'), video('B')]);
  release2();
});

test('a "nothing found" of the old set is never served once an addon is added', async () => {
  const A = addon('A');
  const B = addon('B');
  const r = recorder((a) => (a === B ? [video('B')] : []));
  const before = obtainAggregate<Item>(base(), 'set1', 'stream', [spec(A)], opts);
  const release = before.retain(r.load);
  await until(() => before.getSnapshot().done === 1);
  assert.deepEqual(before.getSnapshot().items, []);

  const after = obtainAggregate<Item>(base(), 'set2', 'stream', [spec(A), spec(B)], opts);
  assert.equal(after.getSnapshot().done, 1, 'B still pending: not a verdict');
  const release2 = after.retain(r.load);
  release();
  await until(() => after.getSnapshot().items.length === 1);
  assert.deepEqual(after.getSnapshot().items, [video('B')]);
  release2();
});

test('reordering keeps every answer (priority order of the new set)', async () => {
  const A = addon('A');
  const B = addon('B');
  const r = recorder((a) => [video(a.manifest.name)]);
  const first = obtainAggregate<Item>(base(), 'set1', 'stream', [spec(A), spec(B)], opts);
  const release = first.retain(r.load);
  await until(() => first.getSnapshot().done === 2);
  const moved = obtainAggregate<Item>(base(), 'set2', 'stream', [spec(B), spec(A)], opts);
  assert.deepEqual(moved.getSnapshot().items, [video('B'), video('A')]);
  const release2 = moved.retain(r.load);
  await sleep(20);
  assert.equal(r.calls.length, 2);
  release();
  release2();
});

test('an empty answer (addon still scraping) is asked again soon while shown, not kept for 20 minutes', async () => {
  const A = addon('A');
  const r = recorder((_a, _req, n) => (n === 1 ? [info] : [video('A')]));
  const job = obtainAggregate<Item>(base(), 'set1', 'stream', [spec(A)], opts);
  const release = job.retain(r.load);
  await until(() => job.getSnapshot().done === 1);
  assert.deepEqual(job.getSnapshot().items, [info]);
  await until(() => job.getSnapshot().items.some((s) => !!s.url), 1000);
  assert.equal(r.count('A'), 2);
  release();
});

test('an empty answer is asked again when the episode is reopened after the short backoff', async () => {
  AGG_TIMING.maxAutoRechecks = 0;
  const A = addon('A');
  const r = recorder((_a, _req, n) => (n === 1 ? [] : [video('A')]));
  const job = obtainAggregate<Item>(base(), 'set1', 'stream', [spec(A)], opts);
  let release = job.retain(r.load);
  await until(() => job.getSnapshot().done === 1);
  release();
  // Reopened at once: the answer is still fresh, not asked again.
  release = job.retain(r.load);
  await sleep(10);
  assert.equal(r.count('A'), 1);
  release();
  await sleep(AGG_TIMING.emptyRecheckMs + 20);
  release = job.retain(r.load);
  assert.equal(job.getSnapshot().done, 0, 'an expired negative answer shows as searching');
  await until(() => job.getSnapshot().items.length === 1);
  assert.equal(r.count('A'), 2);
  release();
});

test('a failure backs off only that addon request, briefly: other episodes still ask it', async () => {
  AGG_TIMING.maxAutoRechecks = 0;
  const A = addon('A');
  let down = true;
  const r = recorder((_a, req) => {
    if (down && req.id === 'kitsu:1:1') throw new Error('HTTP 404');
    return [video(req.id)];
  });
  const ep1 = obtainAggregate<Item>(base(1), 'set1', 'stream', [spec(A, ['kitsu:1:1'])], opts);
  let release1 = ep1.retain(r.load);
  await until(() => ep1.getSnapshot().done === 1);
  assert.deepEqual(ep1.getSnapshot().failed, ['A']);

  // Another episode: not blacklisted.
  const ep2 = obtainAggregate<Item>(base(2), 'set1', 'stream', [spec(A, ['kitsu:1:2'])], opts);
  const release2 = ep2.retain(r.load);
  await until(() => ep2.getSnapshot().items.length === 1);
  release2();

  // Same request within the backoff: not hammered.
  release1();
  release1 = ep1.retain(r.load);
  await sleep(10);
  assert.equal(r.calls.filter((c) => c === 'A:kitsu:1:1').length, 1);
  release1();

  // After the backoff: asked again.
  down = false;
  await sleep(AGG_TIMING.failureBackoffMs + 20);
  release1 = ep1.retain(r.load);
  await until(() => ep1.getSnapshot().items.length === 1);
  assert.deepEqual(ep1.getSnapshot().failed, []);
  release1();
});

test('a failed addon is retried automatically while the screen shows the failure', async () => {
  const A = addon('A');
  const r = recorder((_a, _req, n) => {
    if (n === 1) throw new Error('HTTP 404');
    return [video('A')];
  });
  const job = obtainAggregate<Item>(base(), 'set1', 'stream', [spec(A)], opts);
  const release = job.retain(r.load);
  await until(() => job.getSnapshot().failed.length === 1);
  await until(() => job.getSnapshot().items.length === 1, 1000);
  assert.deepEqual(job.getSnapshot().failed, []);
  release();
});

test('reopened while a cancelled search finishes: the remaining id formats are still asked', async () => {
  const A = addon('A');
  const pending: ((items: Item[]) => void)[] = [];
  let round = 1;
  const r = recorder((_a, req) => {
    if (round === 1) return new Promise<Item[]>((resolve) => pending.push(resolve));
    return req.id.startsWith('tt') ? [video('A')] : [];
  });
  const job = obtainAggregate<Item>(base(), 'set1', 'stream', [spec(A, ['kitsu:1:1', 'mal:1:1', 'tt1:1:1'])], opts);
  let release = job.retain(r.load);
  await until(() => pending.length === 2);
  // The screen goes away (handover grace runs out), then comes back while both requests fly.
  release();
  await sleep(AGG_TIMING.releaseGraceMs + 20);
  release = job.retain(r.load);
  round = 2;
  pending.forEach((resolve) => resolve([]));
  await until(() => job.getSnapshot().done === 1, 1000);
  assert.ok(r.calls.includes('A:tt1:1:1'), 'the third id format was asked');
  assert.deepEqual(job.getSnapshot().items, [video('A')]);
  release();
});

test('a screen searching an episode is visible (no duplicate warm-up)', async () => {
  const A = addon('A');
  const r = recorder(() => [video('A')]);
  const job = obtainAggregate<Item>(base(3), 'set1', 'stream', [spec(A)], opts);
  assert.equal(episodeInUse(base(3)), false);
  const release = job.retain(r.load);
  assert.equal(episodeInUse(base(3)), true);
  assert.equal(episodeInUse(base(4)), false);
  release();
  assert.equal(episodeInUse(base(3)), false);
  await sleep(AGG_TIMING.releaseGraceMs + 10);
});
