/// <reference types="node" />
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  ADDONS_KEY,
  addonSetHash,
  builtin,
  getAddonsState,
  hydrateAddons,
  installAddon,
  isAddonsHydrated,
  moveAddon,
  newlyUsable,
  onAddonsAdded,
  previewAddon,
  removeAddon,
  resetAddonStoreForTests,
  subscribeAddons,
  toggleAddon,
  type InstalledAddon,
} from '../addon-store';
import type { Manifest } from '../protocol';

const manifest = (id: string): Manifest => ({ id: `test.${id}`, name: id.toUpperCase(), resources: ['stream'], types: ['series'] });
const url = (id: string) => `https://${id}.addon.example.test/cfg`;
const installed = (id: string): InstalledAddon => ({ baseUrl: url(id), enabled: true, manifest: manifest(id) });
const saved = async () => JSON.parse((await AsyncStorage.getItem(ADDONS_KEY)) ?? '[]') as InstalledAddon[];

beforeEach(async () => {
  await AsyncStorage.clear();
  resetAddonStoreForTests();
});

test('screens are told once the saved list is loaded (before that only the demo is known)', async () => {
  await AsyncStorage.setItem(ADDONS_KEY, JSON.stringify([installed('a')]));
  assert.equal(isAddonsHydrated(), false);
  assert.deepEqual(getAddonsState().addons.map((a) => a.baseUrl), [builtin.baseUrl]);
  const seen: [boolean, number][] = [];
  const off = subscribeAddons(() => seen.push([isAddonsHydrated(), getAddonsState().addons.length]));
  await hydrateAddons();
  off();
  // The last notification carries both the saved list and the loaded flag.
  assert.deepEqual(seen.at(-1), [true, 2]);
});

test('installAddon validates the manifest and resolves once the list is saved', async () => {
  await assert.rejects(installAddon(url('bad'), {} as Manifest));
  assert.equal(getAddonsState().addons.length, 1);
  await installAddon(url('a'), manifest('a'));
  assert.deepEqual((await saved()).map((a) => a.baseUrl), [builtin.baseUrl, url('a')]);
});

test('a pack installs several addons at once, before the list is even loaded: all kept, on disk too', async () => {
  await AsyncStorage.setItem(ADDONS_KEY, JSON.stringify([installed('old')]));
  await Promise.all(['a', 'b', 'c'].map((id) => installAddon(url(id), manifest(id))));
  const mem = getAddonsState().addons.map((a) => a.baseUrl);
  assert.deepEqual(mem, [builtin.baseUrl, url('old'), url('a'), url('b'), url('c')]);
  assert.deepEqual((await saved()).map((a) => a.baseUrl), mem, 'the last write holds the latest list');
});

test('every change of the set changes its hash; only addons that become usable are announced', async () => {
  await hydrateAddons();
  const added: string[][] = [];
  const off = onAddonsAdded((list) => added.push(list.map((a) => a.baseUrl)));
  const hashes = [getAddonsState().setHash];
  const step = async (p: Promise<unknown>) => {
    await p;
    hashes.push(getAddonsState().setHash);
  };
  await step(installAddon(url('a'), manifest('a')));
  await step(installAddon(url('b'), manifest('b')));
  await step(toggleAddon(url('a')));
  await step(toggleAddon(url('a')));
  await step(moveAddon(url('b'), -1));
  await step(removeAddon(url('b')));
  off();
  for (let i = 1; i < hashes.length; i++) assert.notEqual(hashes[i], hashes[i - 1], `change ${i}`);
  assert.equal(hashes[4], hashes[2], 'same set, same hash');
  assert.deepEqual(added, [[url('a')], [url('b')], [url('a')]]);
});

test('a reconfigured addon (same id, new URL) is announced as new', () => {
  const before = [builtin, installed('a')];
  const after = [builtin, { ...installed('a'), baseUrl: `${url('a')}2` }];
  assert.deepEqual(newlyUsable(before, after).map((a) => a.baseUrl), [`${url('a')}2`]);
  assert.notEqual(addonSetHash(before), addonSetHash(after));
});

test('previewAddon compares with the saved list on a cold start (install link opening the app)', async () => {
  await AsyncStorage.setItem(ADDONS_KEY, JSON.stringify([installed('a')]));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => manifest('a') })) as unknown as typeof fetch;
  try {
    const p = await previewAddon(url('a'));
    assert.equal(p.existing?.baseUrl, url('a'));
  } finally {
    globalThis.fetch = realFetch;
  }
});
