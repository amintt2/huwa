/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AddonStream } from '../protocol';
import {
  bingeAffinity,
  canSwapEngines,
  sameTimeline,
  decideStart,
  durationFromText,
  estimateBitrateMbps,
  evaluateMeasure,
  GRACE_MS,
  HARD_DEADLINE_MS,
  pickUpgrade,
  SOFT_DEADLINE_MS,
  speedLabel,
  speedVerdict,
  swapBlocker,
  SWAP_COOLDOWN_MS,
  SWAP_SETTLE_MS,
  throughputMbps,
  warmStep,
  type RaceCandidate,
  type RaceResult,
  type SwapState,
  type UpgradeCandidate,
} from '../race';

const s = (x: Partial<AddonStream>): AddonStream => ({ addonId: 'a', addonName: 'A', ...x });
const enc = (t: string) => new TextEncoder().encode(t);
const NOW = 1_000_000;

// ---------- measurement / dead links ----------

test('dead links: HTTP errors, timeouts, network errors, pages instead of videos, empty files', () => {
  assert.deepEqual(evaluateMeasure({ status: 404, bytes: 22, ttfbMs: 900, totalMs: 901, contentType: 'text/html' }, NOW).dead, 'http');
  assert.equal(evaluateMeasure({ status: 503, bytes: 0, ttfbMs: 300 }, NOW).dead, 'http');
  assert.equal(evaluateMeasure({ status: 405, bytes: 0, ttfbMs: 300 }, NOW).dead, 'http');
  assert.equal(evaluateMeasure({ status: 0, bytes: 0, timedOut: true }, NOW).dead, 'timeout');
  assert.equal(evaluateMeasure({ status: 0, bytes: 0 }, NOW).dead, 'network');
  // 200 with an HTML page (a host's error page, a login wall…).
  assert.equal(evaluateMeasure({ status: 200, bytes: 3000, contentType: 'text/html; charset=utf-8', ttfbMs: 100, totalMs: 120 }, NOW).dead, 'not-media');
  assert.equal(evaluateMeasure({ status: 200, bytes: 80, contentType: 'application/json', ttfbMs: 100, totalMs: 120 }, NOW).dead, 'not-media');
  // Mislabelled as a download, but the body is markup.
  assert.equal(
    evaluateMeasure({ status: 206, bytes: 4096, contentType: 'application/octet-stream', head: enc('\n  <!DOCTYPE html><html>'), ttfbMs: 100, totalMs: 150 }, NOW).dead,
    'not-media',
  );
  assert.equal(evaluateMeasure({ status: 416, bytes: 0, ttfbMs: 100 }, NOW).dead, 'empty');
  assert.equal(evaluateMeasure({ status: 206, bytes: 0, contentRange: 'bytes */0', ttfbMs: 100, totalMs: 110 }, NOW).dead, 'empty');
});

test('alive links: ranged answer gives throughput and size; Range ignored gives no throughput', () => {
  const r = evaluateMeasure(
    { status: 206, bytes: 262144, contentType: 'application/force-download', contentRange: 'bytes 0-262143/739426282', head: enc('\x1aE\xdf\xa3'), ttfbMs: 472, totalMs: 604 },
    NOW,
  );
  assert.equal(r.alive, true);
  assert.equal(r.ranged, true);
  assert.equal(r.size, 739426282);
  assert.ok(r.mbps! > 15 && r.mbps! < 17, String(r.mbps)); // 262144 B in 132 ms ≈ 15.9 Mb/s
  assert.equal(r.at, NOW);

  const full = evaluateMeasure({ status: 200, bytes: 0, contentType: 'video/mp4', ttfbMs: 300 }, NOW);
  assert.equal(full.alive, true);
  assert.equal(full.ranged, false);
  assert.equal(full.mbps, undefined);

  // Headers in time, body not: alive but stalled.
  const stalled = evaluateMeasure({ status: 206, bytes: 0, ttfbMs: 2000, timedOut: true, contentType: 'video/x-matroska' }, NOW);
  assert.equal(stalled.alive, true);
  assert.equal(stalled.stalled, true);
});

test('throughput needs enough bytes and floors the transfer time', () => {
  assert.equal(throughputMbps(1000, 100, 200), undefined);
  assert.equal(throughputMbps(262144, 100, undefined), undefined);
  // 1 MiB in 1 s ≈ 8.39 Mb/s.
  assert.ok(Math.abs(throughputMbps(1 << 20, 0, 1000)! - 8.388608) < 1e-6);
  // A burst read in 1 ms is not 2 Gb/s: floored at 20 ms.
  assert.ok(Math.abs(throughputMbps(262144, 100, 101)! - (262144 * 8) / 20 / 1000) < 1e-6);
});

// ---------- bitrate ----------

test('bitrate: announced by the addon, else size ÷ duration, else typical for the resolution', () => {
  assert.equal(estimateBitrateMbps(s({ title: '📦 1.5 GB 📊 7.42 Mbps' }), 1080), 7.42);
  assert.equal(estimateBitrateMbps(s({ title: '📦 196 MB 📊 967 Kbps' }), 1080), 0.967);
  assert.equal(durationFromText('🎞️ HEVC ⏱️ 23m:40s'), 23 * 60 + 40);
  assert.equal(durationFromText('⏱️ 1h:02m'), 3720);
  assert.equal(durationFromText('no duration'), undefined);
  const sized = estimateBitrateMbps(s({ title: '⏱️ 23m:40s', behaviorHints: { videoSize: 739426282 } }), 1080);
  assert.ok(Math.abs(sized - (739426282 * 8) / 1420 / 1e6) < 1e-9);
  // Size without duration: an anime episode (24 min).
  assert.ok(Math.abs(estimateBitrateMbps(s({ behaviorHints: { videoSize: 1440 * 1e6 } }), null) - 8) < 1e-9);
  assert.equal(estimateBitrateMbps(s({}), 1080), 7);
  assert.equal(estimateBitrateMbps(s({}), 2160), 18);
  assert.equal(estimateBitrateMbps(s({}), null), 6);
});

// ---------- verdicts ----------

const alive = (mbps: number | undefined, ttfbMs: number, extra: Partial<RaceResult> = {}): RaceResult => ({ alive: true, mbps, ttfbMs, at: NOW, ...extra });
const deadR = (status = 404): RaceResult => ({ alive: false, dead: 'http', status, at: NOW });

test('speed verdicts against the stream bitrate', () => {
  assert.equal(speedVerdict(alive(16, 470), 7.4), 'fast');
  assert.equal(speedVerdict(alive(5, 470), 7.4), 'ok'); // ≥ half the bitrate
  assert.equal(speedVerdict(alive(2, 470), 7.4), 'slow');
  assert.equal(speedVerdict(alive(40, 4500), 7.4), 'ok'); // fast pipe, slow to answer
  assert.equal(speedVerdict(alive(40, 7000), 7.4), 'slow');
  assert.equal(speedVerdict(alive(undefined, 800), 7.4), 'ok'); // Range ignored: never "fast"
  assert.equal(speedVerdict(alive(undefined, 4000), 7.4), 'slow');
  assert.equal(speedVerdict(alive(40, 300, { stalled: true }), 7.4), 'slow');
  assert.equal(speedVerdict(deadR(), 7.4), 'dead');
});

// ---------- initial selection ----------

const c = (key: string, x: Partial<RaceCandidate> = {}): RaceCandidate => ({ key, lang: 0, quality: 1080, bitrateMbps: 7, probing: false, ...x });

test('language first: a fast dubbed link never beats the VOSTFR one the user prefers', () => {
  const dub = c('dub', { lang: 12, result: alive(40, 200), doneAtMs: 300 });
  const vost = c('vost', { lang: 0, probing: true });
  // VOSTFR still in flight: wait, even though the dub is fast.
  assert.equal(decideStart([vost, dub], 400).key, null);
  // VOSTFR merely "ok" after the soft deadline: still chosen over the fast dub.
  const vostOk = { ...vost, probing: false, result: alive(4, 1500), doneAtMs: 1500 };
  assert.deepEqual(decideStart([vostOk, dub], SOFT_DEADLINE_MS), { key: 'vost', why: 'ok' });
  // VOSTFR dead: the next language tier plays.
  const vostDead = { ...vost, probing: false, result: deadR() };
  assert.deepEqual(decideStart([vostDead, dub], 900), { key: 'dub', why: 'fast' });
});

test('grace window: the first fast answer waits briefly for a better quality still in flight', () => {
  const hd = c('720', { quality: 720, bitrateMbps: 3.5, result: alive(20, 300), doneAtMs: 400 });
  const fhd = c('1080', { quality: 1080, probing: true });
  const d = decideStart([fhd, hd], 500);
  assert.equal(d.key, null);
  assert.ok('waitMs' in d && Math.abs(d.waitMs - (400 + GRACE_MS - 500)) < 1e-9);
  // Grace over: the fast 720p starts, the 1080p may come later as an upgrade.
  assert.deepEqual(decideStart([fhd, hd], 400 + GRACE_MS + 1), { key: '720', why: 'fast' });
  // The 1080p answers fast within the window: it wins.
  const fhdFast = { ...fhd, probing: false, result: alive(25, 350), doneAtMs: 700 };
  assert.deepEqual(decideStart([fhdFast, hd], 700), { key: '1080', why: 'fast' });
  // Nothing better pending: no wait at all.
  const sd = c('480', { quality: 480, probing: true });
  assert.deepEqual(decideStart([hd, sd], 450), { key: '720', why: 'fast' });
});

test('slow links: ok after the soft deadline, slow only at the hard deadline, plain ranking last', () => {
  const okC = c('ok', { result: alive(4, 1000), doneAtMs: 1000 });
  const pend = c('pending', { quality: 1080, probing: true });
  assert.equal(decideStart([okC, pend], 1200).key, null);
  assert.deepEqual(decideStart([okC, pend], SOFT_DEADLINE_MS + 1), { key: 'ok', why: 'ok' });

  const slow = c('slow', { result: alive(1, 5000), doneAtMs: 5000 });
  assert.equal(decideStart([slow, pend], 5200).key, null);
  assert.deepEqual(decideStart([slow, pend], HARD_DEADLINE_MS), { key: 'slow', why: 'alive' });
  // Nothing answered by the hard deadline: first of the ranking.
  assert.deepEqual(decideStart([pend, c('other', { probing: true })], HARD_DEADLINE_MS), { key: 'pending', why: 'fallback' });
});

test('nothing raced (no budget, torrents only): the plain ranking, immediately', () => {
  assert.deepEqual(decideStart([c('a'), c('b')], 0), { key: 'a', why: 'fallback' });
  assert.deepEqual(decideStart([], 0), { key: null, exhausted: true });
  assert.deepEqual(decideStart([c('x', { result: deadR() })], 0), { key: null, exhausted: true });
});

test('dead links are eliminated before the player sees them', () => {
  const d = decideStart([c('404', { quality: 2160, result: deadR() }), c('ok', { result: alive(30, 400), doneAtMs: 400 })], 500);
  assert.deepEqual(d, { key: 'ok', why: 'fast' });
});

test('same release as the previous episode is kept unless it is slow', () => {
  const binge = c('binge', { quality: 720, binge: true, result: alive(10, 400), doneAtMs: 400 });
  const better = c('better', { quality: 1080, result: alive(40, 200), doneAtMs: 200 });
  assert.deepEqual(decideStart([better, binge], 500), { key: 'binge', why: 'binge' });
  const slowBinge = { ...binge, result: alive(0.5, 400) };
  assert.deepEqual(decideStart([better, slowBinge], 500), { key: 'better', why: 'fast' });
  // Still measuring the binge release: wait for it (until the soft deadline).
  assert.equal(decideStart([better, { ...binge, result: undefined, probing: true }], 500).key, null);
});

// ---------- upgrades ----------

const side = { key: 'cur', lang: 0, resolution: 720, quality: 720, bingeGroup: 'aio|720p|WEB-DL|Tsundere' };
const up = (key: string, x: Partial<UpgradeCandidate> = {}): UpgradeCandidate => ({ key, lang: 0, resolution: 1080, quality: 1080, speed: 'fast', mbps: 20, ...x });

test('upgrade: strictly better resolution, same language fit, proved fast, never in manual mode', () => {
  assert.equal(pickUpgrade(side, [up('a')], false)?.key, 'a');
  assert.equal(pickUpgrade(side, [up('a')], true), null);
  assert.equal(pickUpgrade(side, [up('a', { lang: 5 })], false), null); // other language
  assert.equal(pickUpgrade(side, [up('a', { resolution: 720, quality: 720 })], false), null); // not better
  assert.equal(pickUpgrade(side, [up('a', { speed: 'ok' })], false), null); // not proved fast
  assert.equal(pickUpgrade(side, [up('a', { speed: undefined })], false), null); // not measured
  assert.equal(pickUpgrade(side, [up('a', { web: true })], false), null); // hosted page
  assert.equal(pickUpgrade({ ...side, web: true }, [up('a')], false), null);
  // Over the preferred-quality cap (score lower than the current one): no.
  assert.equal(pickUpgrade(side, [up('a', { resolution: 2160, quality: 600 })], false), null);
});

test('upgrade: same release family (bingeGroup) preferred, then quality, then speed', () => {
  const other = up('other', { resolution: 2160, quality: 2160, bingeGroup: 'aio|2160p|WEB-DL|VARYG', mbps: 90 });
  const family = up('family', { bingeGroup: 'aio|1080p|WEB-DL|Tsundere', mbps: 10 });
  assert.equal(pickUpgrade(side, [other, family], false)?.key, 'family');
  assert.equal(pickUpgrade(side, [up('slow', { mbps: 10 }), up('quick', { mbps: 50 })], false)?.key, 'quick');
  assert.equal(bingeAffinity('a|1080p|X', 'a|1080p|X'), 2);
  assert.equal(bingeAffinity('a|720p|X', 'a|1080p|X'), 1);
  assert.equal(bingeAffinity('a|720p|X', 'a|1080p|Y'), 0);
  assert.equal(bingeAffinity(undefined, 'a'), 0);
});

test('seamless swap: AVPlayer → AVPlayer, mpv → anything (second mpv view), never AVPlayer → mpv', () => {
  assert.equal(canSwapEngines('native', 'native'), true);
  assert.equal(canSwapEngines('native', 'mpv'), false);
  assert.equal(canSwapEngines('mpv', 'native'), true);
  assert.equal(canSwapEngines('mpv', 'mpv'), true);
  assert.equal(canSwapEngines('mpv', 'web'), false);
  assert.equal(sameTimeline(1420, 1421.5), true);
  assert.equal(sameTimeline(1420, 1440), false, 'another cut of the episode');
  assert.equal(sameTimeline(0, 1440), true, 'unknown yet');
  assert.equal(canSwapEngines('web', 'native'), false);
});

test('swap timing rules: playing, settled, first seconds, cooldown, PiP/AirPlay, near the end', () => {
  const okState: SwapState = { playedMs: 60_000, sinceSwapMs: null, playing: true, busy: false, external: false, remainingS: 600 };
  assert.equal(swapBlocker(okState), null);
  assert.equal(swapBlocker({ ...okState, playing: false }), 'paused');
  assert.equal(swapBlocker({ ...okState, busy: true }), 'busy');
  assert.equal(swapBlocker({ ...okState, external: true }), 'external');
  assert.equal(swapBlocker({ ...okState, playedMs: 3000 }), 'too-early');
  assert.equal(swapBlocker({ ...okState, sinceSwapMs: 5000 }), 'cooldown');
  assert.equal(swapBlocker({ ...okState, sinceSwapMs: SWAP_COOLDOWN_MS + 1 }), null);
  assert.equal(swapBlocker({ ...okState, remainingS: 30 }), 'near-end');
  assert.equal(swapBlocker({ ...okState, remainingS: Infinity }), null);
});

test('warm player steps: wait for buffer, arm just before the point, swap, re-park after a seek', () => {
  const base = { ready: true, target: 106, buffered: 112, parkedMs: 1000, mainTime: 101 };
  assert.equal(warmStep({ ...base, ready: false }), 'wait');
  assert.equal(warmStep({ ...base, buffered: 108 }), 'wait'); // < target + 4 s
  assert.equal(warmStep(base), 'wait');
  assert.equal(warmStep({ ...base, mainTime: 105.6 }), 'arm');
  assert.equal(warmStep({ ...base, mainTime: 106 }), 'swap');
  assert.equal(warmStep({ ...base, mainTime: 106.5 }), 'swap'); // overshoot < 0.75 s: still seamless enough
  assert.equal(warmStep({ ...base, mainTime: 140 }), 'retarget'); // user seeked forward
  assert.equal(warmStep({ ...base, mainTime: 20 }), 'retarget'); // user seeked back
  // Engine cannot tell the buffer (-1): trust it after a settle time.
  assert.equal(warmStep({ ...base, buffered: -1, parkedMs: 500, mainTime: 106 }), 'wait');
  assert.equal(warmStep({ ...base, buffered: -1, parkedMs: SWAP_SETTLE_MS, mainTime: 106 }), 'swap');
});

test('speed labels for the sources menu', () => {
  assert.equal(speedLabel(alive(38.2, 1200), 'fast', false), '1,2 s · 38 Mb/s');
  assert.equal(speedLabel(alive(7.6, 800), 'ok', false), '0,8 s · 7,6 Mb/s');
  assert.equal(speedLabel(alive(1, 4100), 'slow', false), 'lent · 4,1 s · 1,0 Mb/s');
  assert.equal(speedLabel(deadR(404), 'dead', false), 'hors ligne (404)');
  assert.equal(speedLabel({ alive: false, dead: 'timeout', at: NOW }, 'dead', false), 'hors ligne (délai dépassé)');
  assert.equal(speedLabel(undefined, undefined, true), 'test…');
  assert.equal(speedLabel(undefined, undefined, false), null);
});

test('HLS / DASH manifests are judged on response time, not throughput', () => {
  const enc = (t: string) => new TextEncoder().encode(t);
  const hls = evaluateMeasure({ status: 200, contentType: 'text/plain', head: enc('#EXTM3U\n#EXT-X-VERSION:3'), bytes: 900, ttfbMs: 300, totalMs: 320 });
  assert.equal(hls.alive, true);
  assert.equal(hls.adaptive, true);
  assert.equal(speedVerdict(hls, 7), 'fast');
  const dash = evaluateMeasure({ status: 200, contentType: 'application/dash+xml', head: enc('<?xml version="1.0"?><MPD'), bytes: 2000, ttfbMs: 4000, totalMs: 4100 });
  assert.equal(dash.alive, true);
  assert.equal(speedVerdict(dash, 7), 'ok');
});
