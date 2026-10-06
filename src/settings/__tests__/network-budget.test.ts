/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NO_TORRENT_PROBES, TORRENT_PROBES_METERED, TORRENT_PROBES_UNMETERED, torrentProbeBudget } from '../network-budget';

test('torrent probes: none when streaming is not allowed', () => {
  assert.deepEqual(torrentProbeBudget(false, false), NO_TORRENT_PROBES);
  assert.deepEqual(torrentProbeBudget(false, true), NO_TORRENT_PROBES);
});

test('torrent probes: the race widens further on Wi-Fi, stays capped on cellular', () => {
  const wifi = torrentProbeBudget(true, false);
  const cell = torrentProbeBudget(true, true);
  assert.deepEqual(wifi, TORRENT_PROBES_UNMETERED);
  assert.deepEqual(cell, TORRENT_PROBES_METERED);
  assert.ok(wifi.max > wifi.base && wifi.max <= 8, 'the engine runs 8 probes at once at most');
  assert.ok(cell.max <= 3 && cell.max >= cell.base);
  assert.ok(wifi.max > cell.max);
});
