/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  afterExhausted,
  decidePeerRace,
  packKeys,
  unpackKeys,
  LANG_GRACE_MS,
  PEER_RACE_DEADLINE_MS,
  peerLabel,
  probeTargets,
  shouldWiden,
  SOFT_COMMIT_MS,
  WIDEN_AFTER_MS,
  wrongTorrents,
  type PeerCandidate,
  type PeerProbe,
} from '../peer-race';

const p = (state: PeerProbe['state'], x: Partial<PeerProbe> = {}): PeerProbe => ({ state, peers: 0, connected: 0, local: false, ...x });
const c = (key: string, lang: number, probe?: PeerProbe): PeerCandidate => ({ key, lang, probe });

test('probes the first N candidates (already sorted, language first)', () => {
  const list = ['a', 'b', 'c', 'd', 'e'].map((key) => ({ key }));
  assert.deepEqual(probeTargets(list, 4), ['a', 'b', 'c', 'd']);
  assert.deepEqual(probeTargets(list, 2), ['a', 'b']);
  assert.deepEqual(probeTargets(list, 0), [], 'no budget (offline, Wi-Fi only on cellular)');
});

test('waits while nothing is probed yet or everything is still resolving', () => {
  // Re-evaluated at the next checkpoint (widening, soft commit, deadline).
  assert.deepEqual(decidePeerRace([c('a', 0), c('b', 0)], 0), { key: null, waitMs: WIDEN_AFTER_MS });
  assert.deepEqual(decidePeerRace([c('a', 0), c('b', 0)], 1000), { key: null, waitMs: SOFT_COMMIT_MS - 1000 });
  const d = decidePeerRace([c('a', 0, p('resolving', { peers: 40 })), c('b', 0, p('queued'))], 2000);
  assert.equal(d.key, null);
  assert.ok('waitMs' in d && d.waitMs === PEER_RACE_DEADLINE_MS - 2000);
});

test('the first healthy swarm wins at once, even if it is not the first choice', () => {
  const d = decidePeerRace([c('a', 0, p('resolving', { peers: 3 })), c('b', 0, p('healthy', { connected: 4, doneAtMs: 1200 }))], 1300);
  assert.deepEqual(d, { key: 'b', why: 'healthy' });
});

test('several healthy: best language, then preference order', () => {
  const d = decidePeerRace(
    [c('a', 1, p('healthy', { connected: 9 })), c('b', 0, p('healthy', { connected: 3 })), c('c', 0, p('healthy', { connected: 8 }))],
    2000,
  );
  assert.deepEqual(d, { key: 'b', why: 'healthy' });
});

test('a healthy torrent in a worse language waits briefly for a better one', () => {
  const cands = [c('vf', 0, p('resolving')), c('vostfr', 1, p('healthy', { connected: 5, doneAtMs: 1000 }))];
  const d = decidePeerRace(cands, 1200);
  assert.ok(d.key === null && 'waitMs' in d && d.waitMs === 1000 + LANG_GRACE_MS - 1200);
  // Grace over: take it.
  assert.deepEqual(decidePeerRace(cands, 1000 + LANG_GRACE_MS), { key: 'vostfr', why: 'healthy' });
  // The better one turned healthy meanwhile.
  assert.deepEqual(decidePeerRace([c('vf', 0, p('healthy', { connected: 3, doneAtMs: 1800 })), cands[1]], 1900), { key: 'vf', why: 'healthy' });
  // The better one failed: no need to wait.
  assert.deepEqual(decidePeerRace([c('vf', 0, p('failed')), cands[1]], 1100), { key: 'vostfr', why: 'healthy' });
});

test('a file already complete on the device needs no peer', () => {
  const d = decidePeerRace([c('a', 0, p('resolving')), c('b', 1, p('healthy', { local: true }))], 100);
  assert.deepEqual(d, { key: 'b', why: 'local' });
});

test('at the deadline: the best slow swarm (language, answering peers, discovered peers)', () => {
  const cands = [
    c('a', 0, p('weak', { connected: 1, peers: 10 })),
    c('b', 0, p('weak', { connected: 2, peers: 4 })),
    c('c', 0, p('resolving', { peers: 50 })),
    c('d', 1, p('weak', { connected: 2, peers: 99 })),
  ];
  assert.equal(decidePeerRace(cands, 1000).key, null, 'still probing before the soft deadline');
  // Soft deadline: no healthy one, the best with an answering peer wins without waiting for 'c'.
  assert.deepEqual(decidePeerRace(cands, SOFT_COMMIT_MS), { key: 'b', why: 'best' });
  assert.deepEqual(decidePeerRace(cands, PEER_RACE_DEADLINE_MS), { key: 'b', why: 'best' });
  // Every probe over before the deadline: no need to wait.
  const over = [c('a', 0, p('weak', { connected: 0, peers: 10 })), c('b', 0, p('weak', { connected: 0, peers: 30 }))];
  assert.deepEqual(decidePeerRace(over, 3000), { key: 'b', why: 'best' });
});

test('soft deadline needs an answering peer; a probe still resolving counts once it found the file', () => {
  const none = [c('a', 0, p('weak', { peers: 9 })), c('b', 0, p('resolving', { peers: 4 }))];
  assert.equal(decidePeerRace(none, SOFT_COMMIT_MS).key, null, 'nobody answered yet: keep probing until the deadline');
  assert.deepEqual(decidePeerRace(none, PEER_RACE_DEADLINE_MS), { key: 'a', why: 'best' });
  const resolving = [c('a', 0, p('resolving', { connected: 1, peers: 2, fileIdx: 3 })), c('b', 0, p('resolving', { connected: 2 }))];
  // 'b' has peers but no metadata yet (no file): not playable.
  assert.deepEqual(decidePeerRace(resolving, SOFT_COMMIT_MS), { key: 'a', why: 'best' });
});

test('widens the race when every candidate looks weak', () => {
  const weak = [p('resolving', { connected: 1 }), p('weak', { connected: 2 })];
  assert.equal(shouldWiden(weak, WIDEN_AFTER_MS - 1), false, 'too early to tell');
  assert.equal(shouldWiden(weak, WIDEN_AFTER_MS), true);
  assert.equal(shouldWiden([...weak, p('resolving', { connected: 3 })], WIDEN_AFTER_MS), false, 'one swarm is fine');
  assert.equal(shouldWiden([...weak, p('healthy', { connected: 3 })], WIDEN_AFTER_MS), false);
  assert.equal(shouldWiden([p('failed'), p('noFile')], 300), true, 'every probe already over');
  assert.equal(shouldWiden([], 5000), false);
});

test('nothing playable: exhausted (the caller falls back to the plain ranking)', () => {
  assert.deepEqual(decidePeerRace([c('a', 0, p('failed')), c('b', 0, p('noFile'))], 3000), { key: null, exhausted: true });
  assert.deepEqual(decidePeerRace([c('a', 0, p('resolving'))], PEER_RACE_DEADLINE_MS), { key: null, exhausted: true });
  assert.deepEqual(decidePeerRace([c('a', 0, p('cancelled'))], 100), { key: null, exhausted: true });
});

test('torrents without the episode are flagged', () => {
  assert.deepEqual(wrongTorrents({ a: p('noFile'), b: p('healthy'), c: undefined }), ['a']);
});

test('sources menu labels', () => {
  assert.equal(peerLabel(undefined), null);
  assert.deepEqual(peerLabel(p('resolving')), { label: 'recherche de pairs…' });
  assert.deepEqual(peerLabel(p('resolving', { peers: 40 })), { label: '40 trouvés…' });
  assert.deepEqual(peerLabel(p('resolving', { peers: 40, connected: 1 })), { label: '1 pair…' });
  assert.deepEqual(peerLabel(p('healthy', { connected: 12 })), { label: '12 pairs', speed: 'fast' });
  assert.deepEqual(peerLabel(p('weak', { connected: 1 })), { label: '1 pair', speed: 'slow' });
  assert.deepEqual(peerLabel(p('weak')), { label: 'aucun pair', speed: 'dead' });
  assert.deepEqual(peerLabel(p('failed')), { label: 'aucun pair', speed: 'dead' });
  assert.deepEqual(peerLabel(p('noFile')), { label: 'épisode absent du torrent', speed: 'dead' });
  assert.deepEqual(peerLabel(p('healthy', { local: true })), { label: 'déjà sur l’appareil', speed: 'fast' });
  assert.equal(peerLabel(p('cancelled')), null);
});

test('stream keys with line breaks survive packing (Torrentio names are "Torrentio\\n1080p")', () => {
  // Regression: the keys were joined / split on '\n', so no target was ever found, the race was
  // armed without a single probe and waited for its deadline forever: nothing chosen, nothing measured.
  const keys = [
    'com.stremio.torrentio.addon||b130fefa|1|||Torrentio\n1080p|[ToonsHub] One Piece\nOne.Piece.S01E02.mkv\n👤 8',
    'com.stremio.torrentio.addon||9fc017ae|1|||Torrentio\n480p|[uP] One Piece\n👤 3',
  ];
  const packed = packKeys(probeTargets(keys.map((key) => ({ key })), 4));
  assert.deepEqual(unpackKeys(packed), keys);
  assert.equal(packKeys([]), '');
  assert.deepEqual(unpackKeys(''), []);
});

test('exhausted race (5G device data): widen first, never a blind start when a probed swarm answers', () => {
  // 3 probes failed (no metadata in time), more candidates unprobed: probe them before starting one blind.
  const cands = [c('a', 0, p('failed')), c('b', 0, p('failed')), c('c', 0, p('weak')), c('d', 0), c('e', 0)];
  assert.equal(afterExhausted(cands, false, 8), 'widen');
  // Widened already: the probed one with an answering peer, not the plain ranking's first.
  const after = [c('a', 0, p('failed')), c('b', 0, p('weak', { connected: 1, peers: 9 })), c('c', 0)];
  assert.deepEqual(afterExhausted(after, true, 8), { key: 'b' });
  // Budget used up: same.
  assert.deepEqual(afterExhausted([c('a', 0, p('weak', { connected: 2 })), c('z', 0)], false, 1), { key: 'a' });
  // Nobody answered anywhere: plain ranking (null).
  assert.equal(afterExhausted([c('a', 0, p('failed')), c('b', 0, p('noFile', { connected: 4 }))], true, 8), null);
});

