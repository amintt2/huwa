/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BIG_PIECE_BYTES, decidePeerRace, PEER_RACE_DEADLINE_MS, PEER_WIN_TTL_MS, reusableWin, type PeerCandidate, type PeerProbe } from '../peer-race';

const win = { key: 'Torrentio\n1080p|abc', at: 10_000, fileIdx: 3 };

test('the tap reuses the race the pre-search just decided', () => {
  assert.equal(reusableWin(win, 12_000, ['x', win.key], 0), win);
});

test('a stale, failed or vanished winner starts a new race', () => {
  assert.equal(reusableWin(undefined, 12_000, [win.key], 0), undefined);
  assert.equal(reusableWin(win, win.at + PEER_WIN_TTL_MS, [win.key], 0), undefined, 'too old');
  assert.equal(reusableWin(win, 12_000, [win.key], 1), undefined, 'a source failed since: new round');
  assert.equal(reusableWin(win, 12_000, ['other'], 0), undefined, 'no longer a candidate (cached by debrid now, list refreshed)');
  assert.equal(reusableWin(win, 9_000, [win.key], 0), undefined, 'clock went back');
});

const p = (state: PeerProbe['state'], x: Partial<PeerProbe> = {}): PeerProbe => ({ state, peers: 0, connected: 0, local: false, ...x });
const c = (key: string, lang: number, probe?: PeerProbe): PeerCandidate => ({ key, lang, probe });
const MIB = 1024 * 1024;

test('among healthy swarms of the same language, smaller pieces win', () => {
  const batch = c('batch-16MiB', 0, p('healthy', { connected: 9, pieceLength: 16 * MIB, doneAtMs: 300 }));
  const single = c('ep-1MiB', 0, p('healthy', { connected: 3, pieceLength: MIB, doneAtMs: 500 }));
  assert.deepEqual(decidePeerRace([batch, single], 600), { key: 'ep-1MiB', why: 'healthy' });
  // Only big-piece swarms healthy: still played (no waiting for a hypothetical better one).
  assert.deepEqual(decidePeerRace([batch, c('dead', 0, p('failed'))], 600), { key: 'batch-16MiB', why: 'healthy' });
  // Language first: a better-language big-piece swarm beats a worse-language small one.
  const other = c('dub-1MiB', 1, p('healthy', { connected: 9, pieceLength: MIB, doneAtMs: 300 }));
  assert.deepEqual(decidePeerRace([batch, other], 600), { key: 'batch-16MiB', why: 'healthy' });
  assert.ok(BIG_PIECE_BYTES <= 8 * MIB);
});

test('weak swarms: answering peers first, then smaller pieces', () => {
  const big = c('big', 0, p('weak', { connected: 1, peers: 9, pieceLength: 16 * MIB, fileIdx: 0 }));
  const small = c('small', 0, p('weak', { connected: 1, peers: 2, pieceLength: 2 * MIB, fileIdx: 0 }));
  assert.deepEqual(decidePeerRace([big, small], PEER_RACE_DEADLINE_MS), { key: 'small', why: 'best' });
  const more = c('big-more-peers', 0, p('weak', { connected: 2, peers: 9, pieceLength: 16 * MIB, fileIdx: 0 }));
  assert.deepEqual(decidePeerRace([more, small], PEER_RACE_DEADLINE_MS), { key: 'big-more-peers', why: 'best' });
});
