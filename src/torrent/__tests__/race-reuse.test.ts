/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PEER_WIN_TTL_MS, reusableWin } from '../peer-race';

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
