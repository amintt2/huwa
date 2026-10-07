/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  assessHealth,
  deviceMaxResolution,
  durationVerdict,
  episodesInName,
  failed,
  initialState,
  MAX_SWITCHES,
  pickStable,
  prepareFailed,
  STABLE_PREPARE_MAX_MS,
  step,
  switched,
  switchToast,
  UPGRADE_AFTER_STABILITY_MS,
  UPGRADE_DWELL_MS,
  type CtlCandidate,
  type CtlInput,
  type CtlState,
  type CurrentSource,
  type Playback,
} from '../source-controller';

const NOW = 1_000_000;

const http = (key: string, o: Partial<CtlCandidate> & { mbps?: number; speed?: 'fast' | 'ok' | 'slow' | 'dead'; at?: number } = {}): CtlCandidate => ({
  key,
  kind: 'http',
  lang: 0,
  resolution: 1080,
  quality: 1080,
  bitrateMbps: 7,
  probeable: true,
  http: o.speed === undefined && o.mbps === undefined ? undefined : { speed: o.speed ?? 'fast', mbps: o.mbps, at: o.at ?? NOW - 1000 },
  ...o,
});

const torrent = (key: string, connected: number | null, o: Partial<CtlCandidate> = {}): CtlCandidate => ({
  key,
  kind: 'torrent',
  lang: 0,
  resolution: 1080,
  quality: 1080,
  bitrateMbps: 7,
  probeable: true,
  swarm: connected == null ? undefined : { connected, healthy: connected >= 3, at: NOW - 1000 },
  ...o,
});

const cur = (o: Partial<CurrentSource> = {}): CurrentSource => ({ key: 'cur', kind: 'http', lang: 0, resolution: 1080, quality: 1080, bitrateMbps: 7, ...o });

const playing = (o: Partial<Playback> = {}): Playback => ({
  started: true,
  sinceLoadMs: 120_000,
  sincePlayMs: 120_000,
  playing: true,
  busy: false,
  external: false,
  position: 300,
  duration: 1440,
  bufferAhead: 20,
  bufferTrend: 0,
  stalls: [],
  stalledNowMs: 0,
  ...o,
});

const input = (o: Partial<CtlInput> = {}): CtlInput => ({
  now: NOW,
  current: cur(),
  playback: playing(),
  candidates: [],
  settings: { auto: true, net: 'unmetered', deviceMaxRes: 2160 },
  episode: { officialMin: 24 },
  ...o,
});

/** Stalls `agoMs` ago, `ms` long each. */
const stalls = (...list: [agoMs: number, ms: number][]) => list.map(([ago, ms]) => ({ at: NOW - ago, ms }));

describe('upgrade path', () => {
  test('a fast 2160p link with margin is prepared on Wi-Fi (seamless)', () => {
    const r = step(initialState(), input({ candidates: [http('4k', { resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 40 })] }));
    assert.deepEqual(r.action, { type: 'prepare', key: '4k', reason: 'upgrade' });
    assert.equal(r.state.preparing?.key, '4k');
  });

  test('no margin over its own bitrate: no upgrade', () => {
    const r = step(initialState(), input({ candidates: [http('4k', { resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 20 })] }));
    assert.equal(r.action.type, 'hold');
  });

  test('stale probe: re-probed, not trusted', () => {
    const c = http('4k', { resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 40, at: NOW - 10 * 60_000 });
    const r = step(initialState(), input({ candidates: [c] }));
    assert.equal(r.action.type, 'hold');
    assert.deepEqual(r.reprobe, ['4k']);
  });

  test('cellular "équilibré": capped at 1080p, 4K never prepared', () => {
    const cands = [http('4k', { resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 60 }), http('fhd', { resolution: 1080, quality: 1080, mbps: 30 })];
    const r = step(initialState(), input({ current: cur({ resolution: 720, quality: 720, bitrateMbps: 3.5 }), candidates: cands, settings: { auto: true, net: 'cellular', deviceMaxRes: 2160 } }));
    assert.deepEqual(r.action, { type: 'prepare', key: 'fhd', reason: 'upgrade' });
  });

  test('metered (Low Data Mode): no upgrade, no background probe while healthy', () => {
    const r = step(initialState(), input({ candidates: [http('4k', { resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 60, at: NOW - 600_000 })], settings: { auto: true, net: 'metered', deviceMaxRes: 2160 } }));
    assert.equal(r.action.type, 'hold');
    assert.deepEqual(r.reprobe, []);
  });

  test('device cap: no 4K on a 1080p-class screen', () => {
    const r = step(initialState(), input({ candidates: [http('4k', { resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 60 })], settings: { auto: true, net: 'unmetered', deviceMaxRes: 1080 } }));
    assert.equal(r.action.type, 'hold');
  });

  test('torrents are never upgrade targets (two downloads at once)', () => {
    const r = step(initialState(), input({ candidates: [torrent('t4k', 50, { resolution: 2160, quality: 2160 })] }));
    assert.equal(r.action.type, 'hold');
  });

  test('same release family preferred over a faster unrelated one', () => {
    const cands = [
      http('other', { resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 90, bingeGroup: 'x|2160p|WEB' }),
      http('family', { resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 40, bingeGroup: 'addon|2160p|WEB-DL|FLE' }),
    ];
    const r = step(initialState(), input({ current: cur({ bingeGroup: 'addon|1080p|WEB-DL|FLE' }), candidates: cands }));
    assert.equal(r.action.type === 'prepare' && r.action.key, 'family');
  });

  test('blocked by dwell, a recent stall, near the end, paused, PiP', () => {
    const c = [http('4k', { resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 40 })];
    const why = (p: Partial<Playback>) => {
      const r = step(initialState(), input({ candidates: c, playback: playing(p) }));
      return r.action.type === 'hold' ? r.action.why : r.action.type;
    };
    assert.equal(why({ sincePlayMs: UPGRADE_DWELL_MS - 1 }), 'dwell');
    assert.equal(why({ stalls: stalls([30_000, 500]) }), 'recent-stall');
    assert.equal(why({ position: 1400 }), 'near-end');
    assert.equal(why({ playing: false }), 'not-playing');
    assert.equal(why({ external: true }), 'not-playing');
  });

  test('a failed warm-up is not retried for that episode', () => {
    const c = [http('4k', { resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 40 })];
    let s = step(initialState(), input({ candidates: c })).state;
    s = prepareFailed(s, '4k', 'upgrade');
    assert.equal(s.preparing, null);
    assert.equal(step(s, input({ candidates: c })).action.type, 'hold');
  });

  test('a stall during an upgrade warm-up cancels it (stability first)', () => {
    const c = [http('4k', { resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 40 })];
    const s = step(initialState(), input({ candidates: c })).state;
    const r = step(s, input({ now: NOW + 2000, candidates: c, playback: playing({ stalls: stalls([500, 3000]), stalledNowMs: 3000 }) }));
    assert.deepEqual(r.action, { type: 'cancel', key: '4k', why: 'unhealthy' });
  });

  test('upgrade warm-up times out', () => {
    const c = [http('4k', { resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 40, at: NOW + 30_000 })];
    const s = step(initialState(), input({ candidates: c })).state;
    const r = step(s, input({ now: NOW + 41_000, candidates: c }));
    assert.equal(r.action.type, 'cancel');
    assert.ok(r.state.noUpgrade.includes('4k'));
  });
});

describe('downgrade on stalls', () => {
  test('two stalls in the window: move to a smoother source, even 720p', () => {
    const cands = [http('hd', { resolution: 720, quality: 720, bitrateMbps: 3.5, mbps: 12 })];
    const r = step(initialState(), input({ candidates: cands, playback: playing({ stalls: stalls([40_000, 1500], [10_000, 1200]) }) }));
    assert.equal(r.action.type, 'prepare');
    assert.equal(r.action.type === 'prepare' && r.action.key, 'hd');
    assert.equal(r.action.type === 'prepare' && r.action.reason, 'stall');
  });

  test('stalled right now: hard switch at once, the old source remembered as bad', () => {
    const cands = [http('hd', { resolution: 720, quality: 720, bitrateMbps: 3.5, mbps: 12 })];
    const r = step(initialState(), input({ candidates: cands, playback: playing({ stalls: stalls([30_000, 1000], [3000, 3000]), stalledNowMs: 3000, bufferAhead: 0 }) }));
    assert.deepEqual(r.action, { type: 'switch', key: 'hd', reason: 'stall' });
    assert.equal(r.state.bad.cur, 'stall');
  });

  test('a single stall is not enough (no flapping on a hiccup)', () => {
    const cands = [http('hd', { resolution: 720, quality: 720, bitrateMbps: 3.5, mbps: 12 })];
    const r = step(initialState(), input({ candidates: cands, playback: playing({ stalls: stalls([10_000, 800]) }) }));
    assert.equal(r.action.type, 'hold');
  });

  test('draining buffer: proactive move to a comfortable source before any stall', () => {
    const cands = [http('hd', { resolution: 720, quality: 720, bitrateMbps: 3.5, mbps: 12 })];
    const r = step(initialState(), input({ candidates: cands, playback: playing({ bufferAhead: 5, bufferTrend: -0.6 }) }));
    assert.equal(r.action.type, 'prepare');
  });

  test('draining buffer but only a borderline alternative: hold and re-probe', () => {
    const cands = [http('hd', { resolution: 720, quality: 720, bitrateMbps: 3.5, mbps: 4, at: NOW - 60_000 })];
    const r = step(initialState(), input({ candidates: cands, playback: playing({ bufferAhead: 5, bufferTrend: -0.6 }) }));
    assert.equal(r.action.type, 'hold');
    assert.deepEqual(r.reprobe, ['hd']);
  });

  test('nothing measured as better: hold, and the alternatives are re-probed urgently', () => {
    const cands = [http('a'), http('b', { speed: 'slow', mbps: 2 })];
    const r = step(initialState(), input({ candidates: cands, playback: playing({ stalls: stalls([40_000, 1500], [10_000, 1200]) }) }));
    assert.equal(r.action.type, 'hold');
    assert.ok(r.reprobe.includes('a'));
  });

  test('a stability warm-up that stalls again becomes a hard switch', () => {
    const cands = [http('hd', { resolution: 720, quality: 720, bitrateMbps: 3.5, mbps: 12 })];
    const p0 = playing({ stalls: stalls([40_000, 1500], [10_000, 1200]) });
    const s = step(initialState(), input({ candidates: cands, playback: p0 })).state;
    const r = step(s, input({ now: NOW + 3000, candidates: cands, playback: playing({ stalls: [...p0.stalls, { at: NOW + 2500, ms: 500 }], stalledNowMs: 500 }) }));
    assert.deepEqual(r.action, { type: 'switch', key: 'hd', reason: 'stall' });
  });

  test('a stability warm-up too slow becomes a hard switch', () => {
    const cands = [http('hd', { resolution: 720, quality: 720, bitrateMbps: 3.5, mbps: 12 })];
    const p0 = playing({ stalls: stalls([40_000, 1500], [10_000, 1200]) });
    const s = step(initialState(), input({ candidates: cands, playback: p0 })).state;
    const r = step(s, input({ now: NOW + STABLE_PREPARE_MAX_MS + 1, candidates: cands, playback: p0 }));
    assert.equal(r.action.type, 'switch');
  });

  test('seamless failed for a target: the next stability switch to it is hard', () => {
    const cands = [http('hd', { resolution: 720, quality: 720, bitrateMbps: 3.5, mbps: 12 })];
    const s = prepareFailed(initialState(), 'hd', 'stall');
    const r = step(s, input({ candidates: cands, playback: playing({ stalls: stalls([40_000, 1500], [10_000, 1200]) }) }));
    assert.equal(r.action.type, 'switch');
  });
});

describe('torrents (device data, 5G)', () => {
  test('1 peer + repeated stalls is an immediate switch (10 stalls / 64.8 s seen on device)', () => {
    const cands = [torrent('healthy', 12)];
    const p = playing({ sincePlayMs: 3000, peers: 1, stalls: stalls([20_000, 6000], [5000, 4000]) });
    const r = step(initialState(), input({ current: cur({ kind: 'torrent' }), candidates: cands, playback: p }));
    assert.deepEqual(r.action, { type: 'switch', key: 'healthy', reason: 'weak-swarm' });
  });

  test('never an unprobed torrent, never a weak swarm, when a probed healthy one exists', () => {
    const cands = [torrent('unprobed', null, { quality: 2000 }), torrent('weak', 1), torrent('healthy', 6)];
    const p = playing({ peers: 1, stalls: stalls([20_000, 6000], [5000, 4000]) });
    const r = step(initialState(), input({ current: cur({ kind: 'torrent' }), candidates: cands, playback: p }));
    assert.equal(r.action.type === 'switch' && r.action.key, 'healthy');
  });

  test('only unprobed / weak torrents: hold and probe them, no blind switch', () => {
    const cands = [torrent('unprobed', null), torrent('weak', 1)];
    const p = playing({ peers: 1, stalls: stalls([20_000, 6000], [5000, 4000]) });
    const r = step(initialState(), input({ current: cur({ kind: 'torrent' }), candidates: cands, playback: p }));
    assert.equal(r.action.type, 'hold');
    assert.ok(r.reprobe.includes('unprobed'));
  });

  test('weak swarm: a fast direct link beats another torrent', () => {
    const cands = [torrent('healthy', 20, { quality: 1081 }), http('direct', { mbps: 30 })];
    const p = playing({ peers: 1, stalls: stalls([20_000, 6000], [5000, 4000]) });
    const r = step(initialState(), input({ current: cur({ kind: 'torrent' }), candidates: cands, playback: p }));
    assert.equal(r.action.type === 'switch' && r.action.key, 'direct');
  });

  test('torrent → torrent is always a hard switch (the old one released, never two downloads)', () => {
    const cands = [torrent('healthy', 12)];
    const p = playing({ peers: 5, stalls: stalls([40_000, 1500], [10_000, 1200]), bufferAhead: 15 });
    const r = step(initialState(), input({ current: cur({ kind: 'torrent' }), candidates: cands, playback: p }));
    assert.equal(r.action.type, 'switch');
  });

  test('torrent slow start (no frame after 12 s, metadata from the magnet): next probed healthy swarm', () => {
    const cands = [torrent('healthy', 8), torrent('unprobed', null)];
    const p = playing({ started: false, sinceLoadMs: 12_500, sincePlayMs: 0 });
    const r = step(initialState(), input({ current: cur({ kind: 'torrent' }), candidates: cands, playback: p }));
    assert.deepEqual(r.action, { type: 'switch', key: 'healthy', reason: 'slow-start' });
  });
});

describe('slow start (HTTP aggregator: URL at 0.4 s, no frame within 20 s on 5G)', () => {
  test('after 8 s without a frame, the next fast link', () => {
    const cands = [http('rd', { mbps: 20 })];
    const p = playing({ started: false, sinceLoadMs: 8500, sincePlayMs: 0 });
    const r = step(initialState(), input({ candidates: cands, playback: p }));
    assert.deepEqual(r.action, { type: 'switch', key: 'rd', reason: 'slow-start' });
    assert.equal(r.state.bad.cur, 'slow-start');
  });

  test('before 8 s: wait', () => {
    const p = playing({ started: false, sinceLoadMs: 5000, sincePlayMs: 0 });
    assert.equal(step(initialState(), input({ candidates: [http('rd', { mbps: 20 })], playback: p })).action.type, 'hold');
  });
});

describe('hysteresis / no flapping', () => {
  const stallCands = [http('hd', { resolution: 720, quality: 720, bitrateMbps: 3.5, mbps: 12 })];
  const twoStalls = playing({ sincePlayMs: 30_000, stalls: stalls([40_000, 1500], [10_000, 1200]) });

  test('minimum dwell on a fresh source before a (non-critical) stability switch', () => {
    const r = step(initialState(), input({ candidates: stallCands, playback: { ...twoStalls, sincePlayMs: 5000 } }));
    assert.equal(r.action.type === 'hold' && r.action.why, 'stability-wait');
  });

  test('cooldown after a switch', () => {
    const s = switched(initialState(), 'cur', 'stall', NOW - 10_000);
    const r = step(s, input({ candidates: stallCands, playback: twoStalls }));
    assert.equal(r.action.type === 'hold' && r.action.why, 'stability-wait');
  });

  test('never back to a source left for stalling', () => {
    let s = initialState();
    const r1 = step(s, input({ candidates: stallCands, playback: { ...twoStalls, stalledNowMs: 1000 } }));
    assert.equal(r1.action.type, 'switch');
    s = switched(r1.state, 'hd', 'stall', NOW);
    // Now on 'hd', which stalls too; 'cur' is the only alternative and looks fast again.
    const back = http('cur', { mbps: 100 });
    const r2 = step(s, input({ now: NOW + 60_000, current: cur({ key: 'hd', resolution: 720, quality: 720 }), candidates: [back], playback: { ...twoStalls, stalls: stalls([-20_000, 1500], [-50_000, 1200]) } }));
    assert.equal(r2.action.type, 'hold');
  });

  test('no upgrade back up long after a stability switch… only after 3 min', () => {
    const c = [http('4k', { resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 40, at: NOW + 100_000 })];
    const s = switched(initialState(), 'cur', 'stall', NOW);
    assert.equal(step(s, input({ now: NOW + 100_000, candidates: c })).action.type, 'hold');
    const later = NOW + UPGRADE_AFTER_STABILITY_MS + 1;
    const c2 = [http('4k', { resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 40, at: later - 1000 })];
    assert.equal(step(s, input({ now: later, candidates: c2 })).action.type, 'prepare');
  });

  test('a stable source with a slightly better link next to it stays put', () => {
    // Same resolution, a bit faster: never a reason to move.
    const r = step(initialState(), input({ candidates: [http('faster', { mbps: 80 })] }));
    assert.equal(r.action.type, 'hold');
  });

  test('switch cap per episode', () => {
    let s: CtlState = initialState();
    for (let i = 0; i < MAX_SWITCHES; i++) s = switched(s, `k${i}`, 'stall', NOW - 600_000);
    const r = step(s, input({ candidates: stallCands, playback: { ...twoStalls, stalledNowMs: 7000 } }));
    assert.equal(r.action.type, 'hold');
  });

  test('a simulated hour on a healthy source never moves', () => {
    let s = initialState();
    const cands = [http('a', { mbps: 20 }), http('b', { resolution: 720, quality: 720, mbps: 50 })];
    for (let t = 0; t < 3600_000; t += 2000) {
      const r = step(s, input({ now: NOW + t, candidates: cands.map((c) => ({ ...c, http: c.http && { ...c.http, at: NOW + t - 500 } })) }));
      assert.equal(r.action.type, 'hold');
      s = r.state;
    }
  });

  test('alternating good / bad network: at most one switch per cooldown', () => {
    let s = initialState();
    let current = 'a';
    let moves = 0;
    const keys = ['a', 'b', 'c', 'd'];
    for (let t = 0; t < 600_000; t += 2000) {
      const bad = Math.floor(t / 15_000) % 2 === 0;
      const p = playing({ sincePlayMs: 60_000, stalls: bad ? [{ at: NOW + t - 5000, ms: 2000 }, { at: NOW + t - 1000, ms: 1000 }] : [], stalledNowMs: bad ? 1000 : 0, bufferAhead: bad ? 0 : 20 });
      const cands = keys.filter((k) => k !== current).map((k) => http(k, { mbps: 30, at: NOW + t - 100 }));
      const r = step(s, input({ now: NOW + t, current: cur({ key: current }), candidates: cands, playback: p }));
      s = r.state;
      if (r.action.type === 'switch') {
        moves++;
        current = r.action.key;
        s = switched(s, current, r.action.reason, NOW + t);
      }
    }
    // Every source left for stalling is bad: 3 alternatives at most, never ping-pong.
    assert.ok(moves <= 3, `moves ${moves}`);
  });
});

describe('language tier', () => {
  test('never upgrades into another language tier', () => {
    const r = step(initialState(), input({ candidates: [http('vf4k', { lang: 1, resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 60 })] }));
    assert.equal(r.action.type, 'hold');
  });

  test('never downgrades into another language tier, even stalled', () => {
    const r = step(initialState(), input({ candidates: [http('dub', { lang: 12, mbps: 60 })], playback: playing({ stalls: stalls([20_000, 6000], [5000, 4000], [1000, 1000]), stalledNowMs: 7000 }) }));
    assert.equal(r.action.type, 'hold');
  });

  test('a better tier is not a target either (the tier is the user\'s choice of language)', () => {
    const r = step(initialState(), input({ current: cur({ lang: 5 }), candidates: [http('vostfr4k', { lang: 0, resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 60 })] }));
    assert.equal(r.action.type, 'hold');
  });

  test('re-probes stay in the tier', () => {
    const r = step(initialState(), input({ candidates: [http('dub', { lang: 12 }), http('same')] }));
    assert.deepEqual(r.reprobe, ['same']);
  });
});

describe('background probes within the network budget', () => {
  test('Wi-Fi: 3 per round, then nothing until the interval', () => {
    const cands = ['a', 'b', 'c', 'd'].map((k) => http(k));
    const r1 = step(initialState(), input({ candidates: cands }));
    assert.equal(r1.reprobe.length, 3);
    const r2 = step(r1.state, input({ now: NOW + 10_000, candidates: cands }));
    assert.equal(r2.reprobe.length, 0);
    const r3 = step(r1.state, input({ now: NOW + 46_000, candidates: cands }));
    assert.equal(r3.reprobe.length, 3);
  });

  test('cellular: 2 per round', () => {
    const r = step(initialState(), input({ candidates: ['a', 'b', 'c'].map((k) => http(k)), settings: { auto: true, net: 'cellular', deviceMaxRes: 2160 } }));
    assert.equal(r.reprobe.length, 2);
  });

  test('metered: only when the source struggles, one (+1 urgent)', () => {
    const cands = ['a', 'b', 'c'].map((k) => http(k));
    const settings = { auto: true, net: 'metered' as const, deviceMaxRes: 2160 };
    assert.equal(step(initialState(), input({ candidates: cands, settings })).reprobe.length, 0);
    const r = step(initialState(), input({ candidates: cands, settings, playback: playing({ stalls: stalls([20_000, 1000], [5000, 1000]) }) }));
    assert.equal(r.reprobe.length, 2);
  });

  test('offline / blocked: nothing', () => {
    const r = step(initialState(), input({ candidates: [http('a')], settings: { auto: true, net: 'offline', deviceMaxRes: 2160 } }));
    assert.deepEqual(r.reprobe, []);
  });

  test('auto-switching off: no probe, no move', () => {
    const r = step(initialState(), input({ candidates: [http('4k', { resolution: 2160, quality: 2160, bitrateMbps: 18, mbps: 40 })], settings: { auto: false, net: 'unmetered', deviceMaxRes: 2160 } }));
    assert.deepEqual(r, { state: r.state, action: { type: 'hold', why: 'off' }, reprobe: [] });
  });
});

describe('wrong work: official episode length', () => {
  test('verdicts', () => {
    assert.equal(durationVerdict(60 * 60, { officialMin: 24 }), 'too-long'); // One Piece live action, 1 h
    assert.equal(durationVerdict(24 * 60, { officialMin: 24 }), 'ok');
    assert.equal(durationVerdict(42 * 60, { officialMin: 24 }), 'ok'); // < 1.8×
    assert.equal(durationVerdict(47 * 60, { officialMin: 24, edge: true }), 'ok'); // double-length finale
    assert.equal(durationVerdict(70 * 60, { officialMin: 24, edge: true }), 'too-long');
    assert.equal(durationVerdict(90, { officialMin: 24 }), 'too-short'); // trailer / preview
    assert.equal(durationVerdict(48 * 60, { officialMin: 24 }, 2), 'ok'); // "E01-02" file
    assert.equal(durationVerdict(24 * 60, { officialMin: 3 }), 'unknown'); // short-format show
    assert.equal(durationVerdict(24 * 60, {}), 'unknown');
    assert.equal(durationVerdict(NaN, { officialMin: 24 }), 'unknown');
  });

  test('episodes in a name', () => {
    assert.equal(episodesInName('[Group] Show - 01-02 [1080p]'), 2);
    assert.equal(episodesInName('Show S01E01-E02 1080p'), 2);
    assert.equal(episodesInName('Show - 05 [1080p]'), 1);
    assert.equal(episodesInName('Show 0001-2000 batch'), 1);
  });

  test('a 1 h file for a 24 min episode is dropped at once, even with auto-switching off', () => {
    const r = step(initialState(), input({ playback: playing({ duration: 3600, sincePlayMs: 500 }), candidates: [http('anime')], settings: { auto: false, net: 'unmetered', deviceMaxRes: 2160 } }));
    assert.deepEqual(r.action, { type: 'drop', key: 'cur', reason: 'wrong-duration' });
    assert.equal(r.state.bad.cur, 'wrong-duration');
  });

  test('checked once per source, before the first frame too (file loaded)', () => {
    const r1 = step(initialState(), input({ playback: playing({ started: false, sinceLoadMs: 900, duration: 1440 }), candidates: [http('a')] }));
    assert.equal(r1.state.durationChecked, 'cur');
    const r2 = step(r1.state, input({ playback: playing({ duration: 3600 }), candidates: [http('a')] }));
    assert.notEqual(r2.action.type, 'drop');
  });

  test('no alternative: kept (better something than nothing)', () => {
    const r = step(initialState(), input({ playback: playing({ duration: 3600 }) }));
    assert.equal(r.action.type, 'hold');
  });

  test('recap / special names are exempt', () => {
    const r = step(initialState(), input({ currentExempt: true, playback: playing({ duration: 3600 }), candidates: [http('a')] }));
    assert.notEqual(r.action.type, 'drop');
  });
});

describe('health', () => {
  test('levels', () => {
    const c = { kind: 'http' as const, bitrateMbps: 7 };
    assert.equal(assessHealth(c, playing(), NOW).level, 'ok');
    assert.equal(assessHealth(c, playing({ stalls: stalls([10_000, 500]) }), NOW).level, 'ok');
    assert.equal(assessHealth(c, playing({ stalls: stalls([10_000, 500], [5000, 500]) }), NOW).level, 'bad');
    assert.equal(assessHealth(c, playing({ stalls: stalls([10_000, 500], [5000, 500], [1000, 500]) }), NOW).level, 'critical');
    assert.equal(assessHealth(c, playing({ stalls: stalls([200_000, 500], [150_000, 500]) }), NOW).level, 'ok', 'outside the window');
    assert.equal(assessHealth(c, playing({ stalls: stalls([3000, 3000]), stalledNowMs: 3000 }), NOW).level, 'bad');
    assert.equal(assessHealth(c, playing({ stalls: stalls([7000, 7000]), stalledNowMs: 7000 }), NOW).level, 'critical');
    assert.equal(assessHealth(c, playing({ bufferAhead: 4, bufferTrend: -0.5 }), NOW).level, 'risk');
    assert.equal(assessHealth(c, playing({ bufferAhead: 4, bufferTrend: -0.5, position: 1430, duration: 1434 }), NOW).level, 'ok', 'end of file');
    assert.equal(assessHealth({ kind: 'torrent', bitrateMbps: 7 }, playing({ throughputMbps: 3, bufferAhead: 10 }), NOW).level, 'risk');
  });
});

describe('misc', () => {
  test('device resolution cap', () => {
    assert.equal(deviceMaxResolution({ longSidePx: 2796, hevcHw: true }), 2160);
    assert.equal(deviceMaxResolution({ longSidePx: 2532, hevcHw: true }), 2160);
    assert.equal(deviceMaxResolution({ longSidePx: 1792, hevcHw: true }), 1080);
    assert.equal(deviceMaxResolution({ longSidePx: 2796, hevcHw: false }), 1080);
    assert.equal(deviceMaxResolution({ longSidePx: 1792, hevcHw: true, external: true }), 2160);
  });

  test('a source that failed to play is never a target', () => {
    const s = failed(initialState(), 'hd');
    assert.equal(pickStable(cur(), [http('hd', { mbps: 50 })], s, NOW), null);
  });

  test('toasts', () => {
    assert.equal(switchToast('upgrade', 1080, 2160), 'Qualité améliorée · 1080p → 2160p');
    assert.equal(switchToast('stall', 1080, 720), 'Source plus stable');
    assert.equal(switchToast('weak-swarm', 1080, 1080), 'Source plus stable');
  });
});
