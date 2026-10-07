/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  allowsPrewarm,
  backgroundProbes,
  classifyNetwork,
  NO_RACE,
  NO_TORRENT_PROBES,
  RACE_CELLULAR,
  RACE_METERED,
  RACE_UNMETERED,
  raceBudget,
  TORRENT_PROBES_METERED,
  TORRENT_PROBES_UNMETERED,
  torrentProbeBudget,
  torrentProbeBudgetFor,
  torrentWindowed,
  upgradeCap,
  type NetSignals,
} from '../network-budget';

const balanced = { wifiOnly: false, cellularData: 'balanced' as const };
const sig = (o: Partial<NetSignals>): NetSignals => ({ type: 'wifi', connected: true, ...o });

test('torrent probes: none when streaming is not allowed', () => {
  assert.deepEqual(torrentProbeBudget(false, false), NO_TORRENT_PROBES);
  assert.deepEqual(torrentProbeBudget(false, true), NO_TORRENT_PROBES);
  assert.deepEqual(torrentProbeBudget(true, false), TORRENT_PROBES_UNMETERED);
  assert.deepEqual(torrentProbeBudget(true, true), TORRENT_PROBES_METERED);
});

test('classes: Wi-Fi, 5G, Low Data Mode, hotspot, settings', () => {
  assert.equal(classifyNetwork(sig({}), balanced), 'unmetered');
  assert.equal(classifyNetwork(sig({ type: 'ethernet' }), balanced), 'unmetered');
  assert.equal(classifyNetwork(sig({ type: 'unknown' }), balanced), 'unmetered', 'cannot tell: as before');
  assert.equal(classifyNetwork(sig({ type: 'cellular', expensive: true }), balanced), 'cellular');
  // No NWPath (Android, older build): cellular is still "cellular", not metered.
  assert.equal(classifyNetwork(sig({ type: 'cellular' }), balanced), 'cellular');
  assert.equal(classifyNetwork(sig({ type: 'cellular', expensive: true, constrained: true }), balanced), 'metered', 'Low Data Mode');
  assert.equal(classifyNetwork(sig({ constrained: true }), balanced), 'metered', 'Low Data Mode on Wi-Fi too');
  assert.equal(classifyNetwork(sig({ expensive: true }), balanced), 'cellular', 'personal hotspot');
  assert.equal(classifyNetwork(sig({ type: 'cellular' }), { wifiOnly: false, cellularData: 'saver' }), 'metered');
  assert.equal(classifyNetwork(sig({ type: 'cellular' }), { wifiOnly: false, cellularData: 'unlimited' }), 'unmetered');
  assert.equal(classifyNetwork(sig({ type: 'cellular', constrained: true }), { wifiOnly: false, cellularData: 'unlimited' }), 'metered', 'Low Data Mode wins');
  assert.equal(classifyNetwork(sig({ type: 'cellular' }), { wifiOnly: true, cellularData: 'unlimited' }), 'blocked');
  assert.equal(classifyNetwork(sig({ wifiOnly: true } as never), { wifiOnly: true, cellularData: 'balanced' }), 'unmetered', 'Wi-Fi only allows Wi-Fi');
  assert.equal(classifyNetwork(sig({ type: 'none' }), balanced), 'offline');
  assert.equal(classifyNetwork(sig({ connected: false }), balanced), 'offline');
});

test('cellular without Low Data Mode: near-Wi-Fi race and probe budgets', () => {
  assert.deepEqual(raceBudget('unmetered'), RACE_UNMETERED);
  assert.deepEqual(raceBudget('cellular'), RACE_CELLULAR);
  assert.deepEqual(raceBudget('metered'), RACE_METERED);
  assert.deepEqual(raceBudget('blocked'), NO_RACE);
  assert.deepEqual(raceBudget('offline'), NO_RACE);
  assert.ok(RACE_CELLULAR.max >= 8 && RACE_CELLULAR.max > RACE_METERED.max);
  // 5G device data: with 3 probes the race started a torrent it never probed.
  const cell = torrentProbeBudgetFor('cellular');
  assert.deepEqual(cell, torrentProbeBudgetFor('unmetered'));
  assert.ok(cell.max <= 8, 'the engine runs 8 probes at once at most');
  const strict = torrentProbeBudgetFor('metered');
  assert.ok(strict.base >= 3 && strict.max > strict.base, 'even strict, enough to never start blind');
  assert.deepEqual(torrentProbeBudgetFor('blocked'), NO_TORRENT_PROBES);
});

test('pre-warm, torrent window, background probes, upgrade cap per class', () => {
  assert.ok(allowsPrewarm('unmetered') && allowsPrewarm('cellular'));
  assert.ok(!allowsPrewarm('metered') && !allowsPrewarm('blocked') && !allowsPrewarm('offline'));
  assert.ok(!torrentWindowed('unmetered'));
  assert.ok(torrentWindowed('cellular') && torrentWindowed('metered'), 'capped background download on cellular');
  assert.ok(backgroundProbes('unmetered').count > backgroundProbes('cellular').count);
  assert.ok(backgroundProbes('metered').onlyWhenUnhealthy);
  assert.equal(backgroundProbes('offline').count, 0);
  assert.equal(upgradeCap('unmetered'), 2160);
  assert.equal(upgradeCap('cellular'), 1080);
  assert.equal(upgradeCap('metered'), 0);
});
