/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROVIDERS } from '../providers';
import { registerTorrentResolver, resolveCacheKey, resolveTorrent, resolveTorrentViaDebrid, torrentResolverLabel } from '../resolve';
import { clearDebrid, saveDebridKey } from '../store';

test('cache key covers resolver, file and episode', () => {
  const base = { infoHash: 'ABC' };
  const keys = [
    resolveCacheKey('torbox#1', base),
    resolveCacheKey('torbox#2', base),
    resolveCacheKey('huwa-torrent', base),
    resolveCacheKey('torbox#1', { ...base, episode: 2 }),
    resolveCacheKey('torbox#1', { ...base, fileIdx: 3 }),
    resolveCacheKey('torbox#1', { ...base, filename: 'e02.mkv' }),
  ];
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(resolveCacheKey('x', { infoHash: 'ABC' }), resolveCacheKey('x', { infoHash: 'abc' }));
});

test('season pack episodes, account switch and native URLs are never mixed up', async () => {
  const tb = PROVIDERS.torbox as unknown as { validate: (k: string) => Promise<void>; resolve: (k: string, t: { episode?: number }) => Promise<string> };
  let debridCalls = 0;
  tb.validate = async () => {};
  tb.resolve = async (key, t) => {
    debridCalls++;
    return `https://cdn/${key}/ep${t.episode}`;
  };
  await saveDebridKey('torbox', 'A');
  const pack = { infoHash: 'pack' };
  assert.equal((await resolveTorrent({ ...pack, episode: 1 })).url, 'https://cdn/A/ep1');
  assert.equal((await resolveTorrent({ ...pack, episode: 2 })).url, 'https://cdn/A/ep2', 'episode 2 is not episode 1 from the cache');
  assert.equal((await resolveTorrentViaDebrid({ ...pack, episode: 1 }))?.url, 'https://cdn/A/ep1');
  assert.equal(debridCalls, 2, 'same episode served from the cache');
  await saveDebridKey('torbox', 'B');
  assert.equal((await resolveTorrent({ ...pack, episode: 1 })).url, 'https://cdn/B/ep1', 'another account: resolved again');
  await clearDebrid();

  let n = 0;
  const off = registerTorrentResolver({ id: 'native', label: 'moteur', available: () => true, cacheMs: 0, resolve: async () => `http://127.0.0.1:1/x/${++n}` });
  assert.equal((await resolveTorrent(pack)).url, 'http://127.0.0.1:1/x/1');
  assert.equal((await resolveTorrent(pack)).url, 'http://127.0.0.1:1/x/2', 'native URLs are not cached');
  off();
});

test('the resolver label follows the engine being switched on / off (no debrid)', async () => {
  // Regression: after "Activer le moteur torrent" the open episode kept a null label, so its
  // torrents stayed unplayable and the torrent race never started until the screen was left.
  await clearDebrid();
  let on = false;
  assert.equal(torrentResolverLabel(), null);
  const off = registerTorrentResolver({ id: 'huwa-torrent', label: 'moteur Huwa', available: () => on, resolve: async () => 'http://127.0.0.1/x' });
  assert.equal(torrentResolverLabel(), null, 'registered but switched off');
  on = true;
  assert.equal(torrentResolverLabel(), 'moteur Huwa');
  off();
  assert.equal(torrentResolverLabel(), null);
});

