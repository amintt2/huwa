import assert from 'node:assert/strict';
import test from 'node:test';

import { eventOf } from '../../addons/timing';
import {
  bucketOf,
  buildContribution,
  BUCKET_COUNT,
  communityView,
  COUNT_MAX,
  COUNT_MIN,
  geometricNoise,
  histQuantile,
  isContribution,
  K_MIN,
  mergeContributions,
  monthOf,
  type StatsContribution,
} from '../community';
import {
  addonTable,
  classifyPath,
  describeStart,
  engineStartOf,
  failReason,
  formatMs,
  median,
  META_FROM,
  pushRing,
  quantile,
  slowestStep,
  startStages,
  summarize,
  type PlaybackEvent,
} from '../model';

/** Deterministic [0, 1) generator (mulberry32). */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ev = (p: Partial<PlaybackEvent>): PlaybackEvent => ({ at: 1, kind: 'start', warm: false, stalls: 0, stalledMs: 0, fallbackToMpv: false, ...p });

test('classifyPath: by how the URL was obtained, never keeping it', () => {
  assert.equal(classifyPath({ web: true, url: 'https://x.example/embed/1' }), 'web-player');
  assert.equal(classifyPath({ url: 'http://127.0.0.1:8123/abcd/0', torrent: true }), 'torrent-engine');
  assert.equal(classifyPath({ url: 'http://localhost:8123/abcd/0' }), 'torrent-engine');
  assert.equal(classifyPath({ url: 'https://abc.download.real-debrid.com/d/XYZ/ep.mkv', torrent: true }), 'debrid');
  assert.equal(classifyPath({ url: 'https://abc.download.real-debrid.com/d/XYZ/ep.mkv' }), 'debrid');
  assert.equal(classifyPath({ url: 'https://torrentio.strem.fun/resolve/realdebrid/KEY/hash/null/0/ep.mkv' }), 'aggregator-playback');
  assert.equal(classifyPath({ url: 'https://comet.example/playback/b64config/hash/0' }), 'aggregator-playback');
  assert.equal(classifyPath({ url: 'https://mediafusion.example/streaming_provider/secret/stream?info_hash=x' }), 'aggregator-playback');
  assert.equal(classifyPath({ url: 'https://cdn.example.com/hls/ep1/master.m3u8' }), 'http-direct');
  assert.equal(classifyPath({ url: 'https://user:pw@cdn.example.com:8443/v.mp4?token=resolve/' }), 'http-direct');
  assert.equal(classifyPath({}), undefined);
});

test('failReason: coarse categories only', () => {
  assert.equal(failReason('The request timed out.'), 'timeout');
  assert.equal(failReason('P2P: délai dépassé (x)'), 'timeout');
  assert.equal(failReason('HTTP 403 Forbidden'), 'http');
  assert.equal(failReason('The Internet connection appears to be offline.'), 'network');
  assert.equal(failReason('Cannot Open: unsupported codec'), 'format');
  assert.equal(failReason('Lecture impossible'), 'other');
  assert.equal(failReason(undefined), 'other');
});

test('quantile / median / p90 with interpolation', () => {
  assert.equal(median([]), undefined);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1);
  assert.equal(quantile([10, 20], 0), 10);
  assert.equal(quantile([10, 20], 1), 20);
});

test('summarize: success rate, paths, engines, warm/cold, stalls, recent bars', () => {
  const events = [
    ev({ path: 'http-direct', engine: 'native', tFirstFrame: 1000, tSources: 300, warm: true }),
    ev({ path: 'http-direct', engine: 'native', tFirstFrame: 3000, stalls: 2, stalledMs: 4000 }),
    ev({ path: 'debrid', engine: 'mpv', tFirstFrame: 2000, fallbackToMpv: true, kind: 'resume' }),
    ev({ path: 'torrent-engine', engine: 'native', failed: 'timeout' }),
    ev({ failed: 'no-source' }),
    ev({ path: 'web-player', tFirstFrame: 5000, kind: 'next' }),
  ];
  const s = summarize(events);
  assert.equal(s.total, 6);
  assert.equal(s.overall.n, 4);
  assert.equal(s.overall.median, 2500);
  assert.equal(s.overall.success, 4 / 6);
  assert.equal(s.byPath['http-direct']?.median, 2000);
  assert.equal(s.byPath['http-direct']?.success, 1);
  assert.equal(s.byPath['torrent-engine']?.success, 0);
  assert.equal(s.byEngine.mpv?.n, 1);
  assert.equal(s.byEngine.native?.success, 2 / 3);
  assert.equal(s.warm.median, 1000);
  // Cold starts exclude the web player (no warm handover possible there).
  assert.equal(s.cold.n, 2);
  assert.equal(s.byKind.resume?.median, 2000);
  assert.equal(s.byKind.next?.median, 5000);
  assert.equal(s.stalls.rate, 1 / 4);
  assert.equal(s.stalls.medianMs, 4000);
  assert.equal(s.fallbackRate, 1 / 4);
  assert.equal(s.steps.sources, 300);
  assert.deepEqual(s.recent, [1000, 3000, 2000, null, null, 5000]);
  assert.deepEqual(s.failures, { timeout: 1, 'no-source': 1 });
});

test('addon table: by manifest id, most used first', () => {
  const rows = addonTable({
    'org.a': { name: 'A', ok: 3, fail: 1, ms: [100, 300, 200] },
    'org.b': { name: 'B', ok: 9, fail: 0, ms: [50] },
    'org.c': { name: 'C', ok: 0, fail: 0, ms: [] },
  });
  assert.deepEqual(rows.map((r) => r.id), ['org.b', 'org.a']);
  assert.equal(rows[1].success, 0.75);
  assert.equal(rows[1].median, 200);
  assert.equal(rows[1].n, 4);
});

test('pushRing keeps the last N', () => {
  let r: number[] = [];
  for (let i = 0; i < 510; i++) r = pushRing(r, i, 500);
  assert.equal(r.length, 500);
  assert.equal(r[0], 10);
  assert.equal(r[499], 509);
});

test('formatMs', () => {
  assert.equal(formatMs(undefined), '—');
  assert.equal(formatMs(847), '850 ms');
  assert.equal(formatMs(1440), '1,4 s');
  assert.equal(formatMs(12600), '13 s');
});

test('eventOf: abandoned quickly = nothing, long wait = timeout, played = timings', () => {
  const base = { at: 5, info: {}, stalls: 0, stalledMs: 0 };
  assert.equal(eventOf({ ...base, marks: { screen: 10 } }, 5000), null);
  assert.equal(eventOf({ ...base, marks: {} }, 120_000), null, 'a tap without a watch screen');
  assert.equal(eventOf({ ...base, marks: { screen: 10, sources: 400 } }, 25_000)?.failed, 'timeout');
  assert.equal(eventOf({ ...base, marks: { screen: 10 }, failed: 'no-source' }, 1000)?.failed, 'no-source');
  const e = eventOf(
    { ...base, marks: { screen: 10, sources: 400.4, decision: 900, url: 950, 'first-frame': 1650.6 }, info: { path: 'debrid', engine: 'native', warm: true, network: 'wifi' }, stalls: 1, stalledMs: 800, failed: 'http' },
    60_000,
  )!;
  assert.deepEqual(e, {
    at: 5, kind: 'start', path: 'debrid', engine: 'native', warm: true, tSources: 400, tDecision: 900, tUrl: 950, tFirstFrame: 1651,
    stalls: 1, stalledMs: 800, failed: undefined, fallbackToMpv: false, network: 'wifi', tFileLoaded: undefined, engineStart: undefined,
  });
  // Nothing identifying in an event.
  assert.ok(!/https?:|al\d+:/.test(JSON.stringify(e)));
});

// Engine timeline as `status().start` reports it: ms since the engine's startStream (epoch 10 400).
const timeline = {
  startedAt: 10_400, metaMs: 20, metaFrom: 'probe', firstPeerMs: 300, firstPieceMs: 2_900, firstRequestMs: 450, firstByteMs: 3_000,
  bytesServed: 9_000_000, requests: 4, tailRequests: 1, peersAtFirstByte: 5, initialPeers: 42, peerLimit: 12, pieceBytes: 2_097_152,
};

test('engine timeline on the axis of the tap (numbers only)', () => {
  // Tap at epoch 10 000: the engine started 400 ms later.
  const g = engineStartOf(timeline, 10_000, 3_500_000);
  assert.deepEqual(g, {
    tMeta: 420, metaFrom: META_FROM.probe, tPeer: 700, tPiece: 3_300, tRequest: 850, tFirstByte: 3_400,
    bytes: 3_500_000, requests: 4, tailRequests: 1, peers: 5, initialPeers: 42, peerLimit: 12, pieceKiB: 2048,
  });
  // Marks not reached stay absent; bytes default to the running count; a prefetch started before the tap clamps to 0.
  const cold = engineStartOf({ ...timeline, firstPieceMs: null, firstByteMs: null, peersAtFirstByte: null, metaFrom: 'magnet', startedAt: 9_000 }, 10_000);
  assert.equal(cold.tPiece, undefined);
  assert.equal(cold.tFirstByte, undefined);
  assert.equal(cold.tMeta, 0);
  assert.equal(cold.metaFrom, META_FROM.magnet);
  assert.equal(cold.bytes, 9_000_000);
  assert.ok(!/[a-z]{6,}/i.test(JSON.stringify(Object.values(g))), 'no strings in the event');
});

test('eventOf carries the file-loaded mark and the engine side of a torrent start', () => {
  const e = eventOf(
    {
      at: 10_000,
      marks: { screen: 10, sources: 100, decision: 330, url: 365, 'file-loaded': 3_600, 'first-frame': 4_000 },
      info: { path: 'torrent-engine', engine: 'mpv', engineTimeline: timeline, engineBytesAtFrame: 3_500_000 },
      stalls: 0,
      stalledMs: 0,
    },
    10_000,
  )!;
  assert.equal(e.tFileLoaded, 3_600);
  assert.equal(e.engineStart?.tFirstByte, 3_400);
  assert.equal(e.engineStart?.bytes, 3_500_000);
  // A failed start keeps the engine's last state: where it was stuck.
  const failed = eventOf(
    { at: 10_000, marks: { screen: 10, url: 365 }, info: { path: 'torrent-engine', engineTimeline: { ...timeline, firstPieceMs: null, firstByteMs: null } }, stalls: 0, stalledMs: 0 },
    25_000,
  )!;
  assert.equal(failed.failed, 'timeout');
  assert.equal(failed.engineStart?.tPeer, 700);
  assert.equal(failed.engineStart?.tPiece, undefined);
});

test('start breakdown: stages in order, the longest step, engine facts', () => {
  const e = ev({
    path: 'torrent-engine', engine: 'mpv', tSources: 100, tDecision: 330, tUrl: 365, tFileLoaded: 3_600, tFirstFrame: 17_430,
    engineStart: engineStartOf(timeline, 10_000, 3_500_000),
  });
  const stages = startStages(e);
  assert.deepEqual(stages.map((s) => s.key), ['sources', 'decision', 'url', 'meta', 'peer', 'request', 'piece', 'byte', 'loaded', 'frame']);
  assert.ok(stages.every((s, i) => i === 0 || s.ms >= stages[i - 1].ms));
  const slow = slowestStep(stages)!;
  assert.equal(slow.to.key, 'frame');
  assert.equal(slow.ms, 17_430 - 3_600);
  const line = describeStart(e);
  assert.equal(line.value, '17 s');
  assert.equal(line.failed, false);
  assert.match(line.label, /Moteur torrent · mpv/);
  assert.match(line.stages, /métadonnées \(sonde\) 420 ms → 1er pair 700 ms/);
  assert.match(line.slowest!, /fichier ouvert → image, 14 s/);
  assert.match(line.engine!, /3,3 Mo servis · 4 requêtes \(dont 1 en fin de fichier\) · 5 pairs au 1er octet · 42 pairs de la sonde · limite 12 · pièces 2048 Kio/);
  // Without the engine (HTTP source), fast start: no "longest step" under a second, no engine line.
  const quick = describeStart(ev({ path: 'debrid', engine: 'native', tSources: 200, tUrl: 400, tFirstFrame: 900 }));
  assert.equal(quick.slowest, undefined);
  assert.equal(quick.engine, undefined);
  assert.equal(quick.label, 'Débrid · AVPlayer');
  const failed = describeStart(ev({ path: 'torrent-engine', engine: 'mpv', fallbackToMpv: true, tUrl: 2_291, failed: 'timeout' }));
  assert.equal(failed.value, 'trop long');
  assert.equal(failed.failed, true);
  assert.match(failed.label, /mpv après AVPlayer/);
});

test('buckets and geometric noise', () => {
  assert.equal(bucketOf(0), 0);
  assert.equal(bucketOf(499), 0);
  assert.equal(bucketOf(500), 1);
  assert.equal(bucketOf(19_999), 9);
  assert.equal(bucketOf(60_000), 10);
  const rand = seeded(7);
  const xs = Array.from({ length: 20000 }, () => geometricNoise(rand));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(Math.abs(mean) < 0.05, `zero-mean noise (${mean})`);
  // Var of the two-sided geometric with ε = 1: 2α/(1-α)² ≈ 1.84
  const v = xs.reduce((a, b) => a + b * b, 0) / xs.length;
  assert.ok(v > 1.5 && v < 2.2, `variance ${v}`);
});

test('buildContribution: coarse, noisy, bounded, nothing identifying', () => {
  const events = [
    ...Array.from({ length: 12 }, (_, i) => ev({ path: 'http-direct', tFirstFrame: 800 + i * 100 })),
    ev({ path: 'debrid', tFirstFrame: 1200 }),
    ev({ path: 'debrid', tFirstFrame: 1300 }),
    ev({ path: 'torrent-engine', failed: 'timeout' }),
    ev({ path: 'http-direct', tFirstFrame: 900, stalls: 1 }),
  ];
  const c = buildContribution(events, 'a'.repeat(32), seeded(1))!;
  assert.ok(c);
  assert.ok(isContribution(c));
  // debrid: only 2 samples → not shared.
  assert.deepEqual(Object.keys(c.h), ['http-direct']);
  assert.equal(c.h['http-direct']!.length, BUCKET_COUNT);
  for (const n of [...c.h['http-direct']!, ...c.s]) assert.ok(Number.isInteger(n) && n >= COUNT_MIN);
  assert.ok(c.h['http-direct']!.every((n) => n <= COUNT_MAX));
  assert.deepEqual(Object.keys(c).sort(), ['h', 'id', 's', 'v']);
  assert.equal(buildContribution(events.slice(12, 15), 'b'.repeat(32), seeded(1)), null, 'too little to share');
});

test('noise cancels out across many contributions', () => {
  const rand = seeded(42);
  const events = Array.from({ length: 10 }, () => ev({ path: 'http-direct', tFirstFrame: 1200 })); // bucket 2
  const list: StatsContribution[] = [];
  for (let i = 0; i < 400; i++) list.push(buildContribution(events, i.toString(16).padStart(32, '0'), rand)!);
  const m = mergeContributions(list);
  assert.equal(m.contributions, 400);
  const h = m.h['http-direct']!;
  // True sums: 4000 in bucket 2, 0 elsewhere; noise sd ≈ 1.36 × √400 ≈ 27 per bucket.
  assert.ok(Math.abs(h[2] - 4000) < 150, `bucket 2 = ${h[2]}`);
  assert.ok(h.every((n, i) => i === 2 || Math.abs(n) < 150));
  const med = histQuantile(h, 0.5)!;
  assert.ok(med > 1000 && med < 1500, `median ${med}`);
  assert.ok(Math.abs(m.s[0] - 4000) < 150);
});

test('merge ignores duplicates and invalid contributions; k-anonymity threshold', () => {
  const one: StatsContribution = { id: '1'.repeat(32), v: 1, h: { debrid: new Array(BUCKET_COUNT).fill(2) }, s: [22, 1, 3] };
  const bad = { ...one, id: '2'.repeat(32), h: { debrid: [1] } } as StatsContribution;
  const m = mergeContributions([one, one, bad]);
  assert.equal(m.contributions, 1);
  assert.equal(communityView(m), null);
  const many = mergeContributions(Array.from({ length: K_MIN }, (_, i) => ({ ...one, id: String(i).padStart(32, '0') })));
  const view = communityView(many)!;
  assert.equal(view.contributions, K_MIN);
  assert.ok(view.byPath.debrid && view.byPath.debrid.median! > 0);
  assert.equal(view.success, 22 / 23);
  assert.equal(monthOf(Date.UTC(2026, 9, 31, 23, 59)), '2026-10');
});

test('histQuantile interpolates inside buckets and ignores negative noise', () => {
  const h = new Array(BUCKET_COUNT).fill(0);
  h[1] = 10; // 500–1000 ms
  h[0] = -3;
  assert.equal(histQuantile(h, 0.5), 750);
  assert.equal(histQuantile(new Array(BUCKET_COUNT).fill(-1), 0.5), undefined);
});
