/// <reference types="node" />
// Deterministic timeline of the torrent race with fake engine probes: when does the race commit?
// Budgets (time to first frame < 2 s popular, < 5 s any title): the race must commit within
// 1.5 s on a popular title and 2.5 s (≤ 3 s) on an obscure one; the stream start that follows is
// simulated on the engine side (native/huwa-torrent-core/src/startup_sim.rs). Probe timings below
// come from that simulation (popular: tracker answer 150 ms, 3 handshakes at ~330 ms; obscure:
// 1–2 peers at 300 KB/s, 200 ms RTT).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decidePeerRace,
  PEER_POLL_MS,
  PEER_RACE_DEADLINE_MS,
  shouldWiden,
  type PeerCandidate,
  type PeerDecision,
  type PeerProbe,
} from '../peer-race';
import { TORRENT_PROBES_METERED, TORRENT_PROBES_UNMETERED, type TorrentProbeBudget } from '../../settings/network-budget';

/** A fake engine probe: its status as a function of the time since it started. */
type FakeProbe = (t: number) => PeerProbe;

const probe =
  (opts: { fileAt?: number; answers?: number[]; healthyAt?: number; endAt?: number; end?: 'weak' | 'failed' | 'noFile' }): FakeProbe =>
  (t) => {
    const connected = (opts.answers ?? []).filter((a) => a <= t).length;
    const file = opts.fileAt != null && t >= opts.fileAt;
    if (opts.healthyAt != null && t >= opts.healthyAt) return { state: 'healthy', peers: 40, connected: Math.max(connected, 3), local: false, fileIdx: 0, doneAtMs: opts.healthyAt };
    if (opts.endAt != null && t >= opts.endAt) {
      const state = opts.end ?? (file ? 'weak' : 'failed');
      return { state, peers: connected + 5, connected, local: false, fileIdx: file ? 0 : null, doneAtMs: opts.endAt };
    }
    return { state: 'resolving', peers: connected + (t > 150 ? 5 : 0), connected, local: false, fileIdx: file ? 0 : null };
  };

type Run = { commitMs: number; decision: PeerDecision; widened: boolean; probed: number };

/**
 * Re-evaluates on every poll (`PEER_POLL_MS`, use-peer-race.ts) and when the decision's own
 * `waitMs` timer fires (use-source.ts), and decides like use-source.ts. Probe statuses are only
 * seen as of the last poll.
 */
function race(candidates: FakeProbe[], budget: TorrentProbeBudget, langs: number[] = []): Run {
  const startedAt = new Map<number, number>();
  let width = budget.base;
  let widened = false;
  let polledAt = 0;
  let timerAt = Infinity;
  for (let t = 0; t <= 10_000; t = Math.min((Math.floor(t / PEER_POLL_MS) + 1) * PEER_POLL_MS, timerAt)) {
    if (t % PEER_POLL_MS === 0) polledAt = t;
    const view = () => {
      for (let i = 0; i < Math.min(width, candidates.length); i++) if (!startedAt.has(i)) startedAt.set(i, t);
      return candidates.map((fake, i) => (startedAt.has(i) ? fake(Math.max(0, polledAt - startedAt.get(i)!)) : undefined));
    };
    let probes = view();
    // Same render as the decision in use-source.ts: the widened probes start right away.
    if (!widened && budget.max > budget.base && shouldWiden(probes, t)) {
      widened = true;
      width = budget.max;
      probes = view();
    }
    const cands: PeerCandidate[] = candidates.map((_, i) => ({ key: `c${i}`, lang: langs[i] ?? 0, probe: probes[i] }));
    const decision = decidePeerRace(cands, t);
    if (decision.key !== null || 'exhausted' in decision) return { commitMs: t, decision, widened, probed: startedAt.size };
    // use-source.ts: `setTimeout(..., waitMs + 10)`.
    timerAt = t + decision.waitMs + 10;
  }
  throw new Error('race never ended');
}

const weakSwarm = (i: number) => probe({ fileAt: 750 + i * 100, answers: [550 + i * 100], endAt: 3000 });

test('popular: the first healthy swarm wins within 1.5 s', () => {
  const r = race([probe({ fileAt: 330, answers: [270, 280, 290], healthyAt: 330 }), probe({ healthyAt: 450 }), weakSwarm(0), weakSwarm(1)], TORRENT_PROBES_UNMETERED);
  assert.deepEqual(r.decision, { key: 'c0', why: 'healthy' });
  assert.ok(r.commitMs <= 1500, `${r.commitMs} ms`);
  assert.equal(r.widened, false);
  console.log(`popular: race commits at ${r.commitMs} ms`);
});

test('popular in a worse language: a short grace for the better one, still within 1.5 s', () => {
  const r = race([probe({ fileAt: 900, answers: [800], endAt: 3000 }), probe({ healthyAt: 330 })], TORRENT_PROBES_UNMETERED, [0, 1]);
  assert.equal(r.decision.key, 'c1');
  assert.ok(r.commitMs <= 1500, `${r.commitMs} ms`);
});

test('mid: healthy around half a second', () => {
  const r = race([probe({ healthyAt: 450 }), weakSwarm(0), weakSwarm(1), probe({ endAt: 3000 })], TORRENT_PROBES_UNMETERED);
  assert.equal(r.decision.key, 'c0');
  assert.ok(r.commitMs <= 1500, `${r.commitMs} ms`);
  console.log(`mid: race commits at ${r.commitMs} ms`);
});

test('obscure, only weak swarms: the race widens, then commits on the best answering one by the soft deadline', () => {
  const cands = [weakSwarm(0), weakSwarm(1), probe({ endAt: 3000 }), probe({ fileAt: 900, endAt: 900, end: 'noFile' }), weakSwarm(2), weakSwarm(3), probe({ endAt: 3000 }), probe({ endAt: 3000 })];
  const r = race(cands, TORRENT_PROBES_UNMETERED);
  assert.equal(r.widened, true, 'every candidate looked weak');
  assert.equal(r.probed, 8, 'probes more candidates (packs, other qualities)');
  assert.equal(r.decision.key, 'c0');
  assert.ok(r.commitMs <= 2500, `${r.commitMs} ms`);
  console.log(`obscure: race commits at ${r.commitMs} ms (widened to ${r.probed} probes)`);
});

test('obscure: a pack found by the widened race is healthy and wins', () => {
  const cands = [weakSwarm(0), weakSwarm(1), probe({ endAt: 3000 }), probe({ endAt: 3000 }), probe({ healthyAt: 450 })];
  const r = race(cands, TORRENT_PROBES_UNMETERED);
  assert.equal(r.widened, true);
  assert.deepEqual(r.decision, { key: 'c4', why: 'healthy' });
  assert.ok(r.commitMs <= 2500, `${r.commitMs} ms`);
});

test('metered: widening stays within the cellular budget', () => {
  const cands = [weakSwarm(0), weakSwarm(1), weakSwarm(2), weakSwarm(3), weakSwarm(4)];
  const r = race(cands, TORRENT_PROBES_METERED);
  assert.equal(r.probed, TORRENT_PROBES_METERED.max);
  assert.ok(r.commitMs <= 2500);
});

test('no answering peer at all: the deadline commits on what has the file, else gives up', () => {
  const slow = race([probe({ fileAt: 1200, endAt: 3000 }), probe({ endAt: 3000 })], TORRENT_PROBES_UNMETERED);
  assert.equal(slow.decision.key, 'c0');
  assert.ok(slow.commitMs <= PEER_RACE_DEADLINE_MS + 10, `${slow.commitMs} ms`);
  const dead = race([probe({ endAt: 3000 }), probe({ endAt: 3000 })], TORRENT_PROBES_UNMETERED);
  assert.ok('exhausted' in dead.decision);
  assert.ok(dead.commitMs <= PEER_RACE_DEADLINE_MS + 10, 'the plain ranking takes over by 2.5 s');
});
