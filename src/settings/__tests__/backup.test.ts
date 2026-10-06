/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addonUrlHasPersonalConfig,
  dropMissingSources,
  exportData,
  isExportable,
  personalAddonCount,
  planRestore,
  withoutPersonalAddons,
} from '../backup-core';

test('export keeps user data, leaves caches, cookies and device-bound secrets out', () => {
  for (const k of ['huwa/state/v1', 'huwa/lists/v1', 'huwa/settings/v1', 'huwa/addons/v1', 'huwa/pb/registry/v1', 'huwa/pb/links/v1', 'huwa/prefs/v1', 'huwa/stats/v1']) {
    assert.ok(isExportable(k), k);
  }
  for (const k of [
    'huwa/catalog/v2',
    'huwa/streams/v1/abc',
    'huwa/streams/v1#index',
    'huwa/pb/state/src1',
    'huwa/ids/v2',
    'huwa/franchise/v1',
    'huwa/franchise/seasons/v1',
    'huwa/franchise/seasons/v2',
    'huwa/franchise/specials/v1',
    'huwa/cinemeta/v1/tt0388629',
    'huwa/secure/root',
    'huwa/passkey/v1',
    'huwa/p2p/local/v1',
    'huwa/downloads/v1',
    'huwa/cloud-backup/v1',
    'other/key',
  ]) {
    assert.ok(!isExportable(k), k);
  }
  assert.deepEqual(exportData([['huwa/lists/v1', '[]'], ['huwa/streams/v1/x', '{}'], ['huwa/settings/v1', null]]), { 'huwa/lists/v1': '[]' });
});

test('add-on URLs carrying a configuration are detected and can be dropped', () => {
  assert.ok(addonUrlHasPersonalConfig('https://torrentio.strem.fun/providers=yts|realdebrid=ABCDEF123'));
  assert.ok(addonUrlHasPersonalConfig('https://comet.example/eyJkZWJyaWRBcGlLZXkiOiJhYmMifQ'));
  assert.ok(addonUrlHasPersonalConfig('https://host/addon?token=1'));
  assert.ok(addonUrlHasPersonalConfig('https://user:pass@host/addon'));
  assert.ok(!addonUrlHasPersonalConfig('https://v3-cinemeta.strem.io'));
  assert.ok(!addonUrlHasPersonalConfig('https://opensubtitles-v3.strem.io/'));
  assert.ok(!addonUrlHasPersonalConfig('builtin:demo'));
  const addons = [
    { baseUrl: 'builtin:demo', enabled: true },
    { baseUrl: 'https://torrentio.strem.fun/realdebrid=KEY', enabled: true },
    { baseUrl: 'https://v3-cinemeta.strem.io', enabled: true },
  ];
  const data = { 'huwa/addons/v1': JSON.stringify(addons), 'huwa/lists/v1': '[]' };
  assert.equal(personalAddonCount(data), 1);
  const clean = withoutPersonalAddons(data);
  assert.deepEqual(JSON.parse(clean['huwa/addons/v1']).map((a: { baseUrl: string }) => a.baseUrl), ['builtin:demo', 'https://v3-cinemeta.strem.io']);
  assert.ok(!JSON.stringify(clean).includes('KEY'));
  assert.equal(clean['huwa/lists/v1'], '[]');
});

test('restore plan: writes first, removes only exportable keys absent from the backup', () => {
  const existing = ['huwa/lists/v1', 'huwa/old/v1', 'huwa/streams/v1/x', 'huwa/catalog/v2', 'huwa/p2p/local/v1', 'other'];
  const plan = planRestore(existing, { 'huwa/lists/v1': '[1]', 'huwa/settings/v1': '{}', 'huwa/streams/v1/y': '{}', 'huwa/pb/state/s': '{}' });
  assert.deepEqual(plan.set, [['huwa/lists/v1', '[1]'], ['huwa/settings/v1', '{}']], 'excluded keys of an old export are ignored');
  assert.deepEqual(plan.remove, ['huwa/old/v1'], 'caches and device-bound keys stay');
});

test('installed extension sources without their bundle are dropped on restore', () => {
  const raw = JSON.stringify({ repos: [{ url: 'r' }], installed: [{ key: 'a', name: 'Source A' }, { key: 'b', name: 'Source B' }], legalAccepted: true });
  const r = dropMissingSources(raw, (k) => k === 'a');
  assert.deepEqual(r.dropped, ['Source B']);
  const state = JSON.parse(r.raw);
  assert.deepEqual(state.installed.map((s: { key: string }) => s.key), ['a']);
  assert.equal(state.repos.length, 1);
  assert.equal(dropMissingSources('not json', () => true).raw, 'not json');
});

test('after an import, loaded stores re-read storage and drop their pending stale save', async () => {
  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
  const prefs = await import('../../p2p/prefs');
  const { rehydrateAll } = await import('../rehydrate');
  await prefs.prefsReady;
  prefs.setPrefs((p) => ({ ...p, petnames: { a: 'stale' } })); // debounced save pending
  await AsyncStorage.setItem('huwa/prefs/v1', JSON.stringify({ petnames: { b: 'imported' } }));
  await rehydrateAll();
  assert.deepEqual(prefs.getPrefs().petnames, { b: 'imported' });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(JSON.parse((await AsyncStorage.getItem('huwa/prefs/v1'))!).petnames, { b: 'imported' }, 'stale state not written back');
});
