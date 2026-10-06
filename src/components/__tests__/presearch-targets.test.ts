/// <reference types="node" />
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import AsyncStorage from '@react-native-async-storage/async-storage';

import { installAddon, resetAddonStoreForTests } from '@/addons/addon-store';
import { resetAggregates } from '@/addons/agg-jobs';
import type { Manifest } from '@/addons/protocol';

import { getWinner, park, PRIORITY, propose, resetPresearchTargets, unpark, warmUpNewAddon, type PresearchTarget } from '../presearch-targets';

const target: PresearchTarget = { seriesId: 'al1', episodeId: 'al1-e5', episode: 5 };
const manifest: Manifest = { id: 'test.new', name: 'New', resources: ['stream'] };

beforeEach(async () => {
  resetPresearchTargets();
  resetAggregates();
  resetAddonStoreForTests();
  await AsyncStorage.clear();
});
afterEach(() => resetPresearchTargets());

test('a new addon warms up the series page covered by the add sheet', () => {
  // Mounted but not focused (the sheet is on top): parked, nothing proposed.
  park('detail', target, PRIORITY.detail);
  assert.equal(getWinner(), null);
  assert.deepEqual(warmUpNewAddon(() => false), target);
  assert.equal(getWinner()?.target.episodeId, target.episodeId);
});

test('no warm-up when a screen already searches that episode (it asks the new addon itself)', () => {
  park('detail', target, PRIORITY.detail);
  assert.equal(warmUpNewAddon(() => true), null);
  assert.equal(getWinner(), null);
});

test('no warm-up without a series page (home rows are not enough)', () => {
  park('hero', target, PRIORITY.hero);
  assert.equal(warmUpNewAddon(() => false), null);
});

test('leaving the series page ends its warm-up; its own proposal is not touched', () => {
  park('detail', target, PRIORITY.detail);
  warmUpNewAddon(() => false);
  unpark('detail', target.episodeId);
  assert.equal(getWinner(), null);

  park('detail', target, PRIORITY.detail);
  propose('detail', target, PRIORITY.detail);
  warmUpNewAddon(() => false);
  assert.equal(getWinner()?.target.episodeId, target.episodeId);
});

test('installing an addon triggers the warm-up', async () => {
  park('detail', target, PRIORITY.detail);
  await installAddon('https://new.addon.example.test/cfg', manifest);
  assert.equal(getWinner()?.target.episodeId, target.episodeId);
});
