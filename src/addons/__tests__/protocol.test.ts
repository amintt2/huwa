/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  browsableCatalogs,
  catalogGenres,
  isExternal,
  isYouTube,
  needsConfiguration,
  normalizeAddonUrl,
  normalizeStream,
  searchableCatalogs,
  supports,
  type Manifest,
} from '../protocol';

test('normalizes every way an addon link is shared', () => {
  const base = 'https://torrentio.strem.fun';
  assert.equal(normalizeAddonUrl('https://torrentio.strem.fun/manifest.json'), base);
  assert.equal(normalizeAddonUrl('stremio://torrentio.strem.fun/manifest.json'), base);
  assert.equal(normalizeAddonUrl('torrentio.strem.fun'), base);
  assert.equal(normalizeAddonUrl('https://torrentio.strem.fun/configure'), base);
  assert.equal(normalizeAddonUrl(`https://web.stremio.com/#/addons?addon=${encodeURIComponent(`${base}/manifest.json`)}`), base);
  assert.equal(normalizeAddonUrl(`huwa://addon?url=${encodeURIComponent('stremio://torrentio.strem.fun/manifest.json')}`), base);
  // Configured addons keep their settings path.
  assert.equal(
    normalizeAddonUrl('stremio://torrentio.strem.fun/providers=nyaasi|qualityfilter=480p/manifest.json'),
    'https://torrentio.strem.fun/providers=nyaasi|qualityfilter=480p',
  );
  assert.equal(normalizeAddonUrl('http://127.0.0.1:7000/manifest.json'), 'http://127.0.0.1:7000');
});

// Real manifests (trimmed) of public addons, fetched while writing this test.
const torrentio: Manifest = {
  id: 'com.stremio.torrentio.addon', name: 'Torrentio', catalogs: [],
  resources: [{ name: 'stream', types: ['movie', 'series', 'anime'], idPrefixes: ['tt', 'kitsu'] }],
  types: ['movie', 'series', 'anime', 'other'], behaviorHints: { configurable: true, configurationRequired: false },
};
const aio: Manifest = {
  id: 'com.aiostreams.viren070', name: 'AIOStreams', catalogs: [], resources: [], types: [],
  behaviorHints: { configurable: true, configurationRequired: true },
};
const kitsu: Manifest = {
  id: 'community.anime.kitsu', name: 'Anime Kitsu', resources: ['catalog', 'meta', 'subtitles'], types: ['anime', 'movie', 'series'],
  idPrefixes: ['kitsu', 'mal', 'anilist', 'anidb'],
  catalogs: [
    { id: 'kitsu-anime-trending', name: 'Kitsu Trending', type: 'anime' },
    { id: 'kitsu-anime-airing', type: 'anime', extra: [{ name: 'genre', options: ['Action', 'Drama'] }, { name: 'skip' }] },
    { id: 'kitsu-anime-list', type: 'anime', extra: [{ name: 'search', isRequired: true }, { name: 'skip' }] },
  ],
};
const legacy: Manifest = {
  id: 'x', name: 'Legacy', resources: ['catalog'],
  catalogs: [{ type: 'movie', id: 'top', genres: ['A'], extraSupported: ['search', 'genre', 'skip'] }],
};

test('matches ids and types per resource', () => {
  assert.ok(supports(torrentio, 'stream', 'series', 'kitsu:1:1'));
  assert.ok(supports(torrentio, 'stream', 'series', 'tt0213338:1:1'));
  assert.ok(!supports(torrentio, 'stream', 'series', 'mal:1:1'));
  assert.ok(!supports(torrentio, 'subtitles', 'series', 'tt0213338:1:1'));
  assert.ok(supports(kitsu, 'meta', 'anime', 'mal:1'));
});

test('detects addons that must be configured first', () => {
  assert.ok(needsConfiguration(aio));
  assert.ok(!needsConfiguration(torrentio));
});

test('catalog extras: search, genre, skip, legacy declarations', () => {
  assert.deepEqual(browsableCatalogs(kitsu).map((c) => c.id), ['kitsu-anime-trending', 'kitsu-anime-airing']);
  assert.deepEqual(searchableCatalogs(kitsu).map((c) => c.id), ['kitsu-anime-list']);
  assert.deepEqual(catalogGenres(kitsu.catalogs![1]), ['Action', 'Drama']);
  assert.deepEqual(searchableCatalogs(legacy).map((c) => c.id), ['top']);
  assert.deepEqual(catalogGenres(legacy.catalogs![0]), ['A']);
});

test('stream shapes: infoHash, magnet url, ytId, externalUrl', () => {
  const t = normalizeStream({ infoHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01', fileIdx: 0, sources: ['dht:x'] })!;
  assert.equal(t.infoHash, 'abcdef0123456789abcdef0123456789abcdef01');
  const m = normalizeStream({ url: 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&tr=udp%3A%2F%2Ft.example%3A80' })!;
  assert.equal(m.url, undefined);
  assert.equal(m.infoHash, 'abcdef0123456789abcdef0123456789abcdef01');
  assert.deepEqual(m.sources, ['tracker:udp://t.example:80']);
  assert.ok(isYouTube(normalizeStream({ ytId: 'dQw4w9WgXcQ' })!));
  assert.ok(isExternal(normalizeStream({ externalUrl: 'https://example.com/watch' })!));
  assert.ok(!isExternal({ externalUrl: 'stremio:///detail/series/tt1' }));
  assert.equal(normalizeStream({ name: 'empty' }), null);
  const withSubs = normalizeStream({ url: 'https://x/v.mp4', subtitles: [{ url: 'https://x/fr.srt', lang: 'fre' }, { url: 'file:///x', lang: 'eng' }] })!;
  assert.equal(withSubs.subtitles!.length, 1);
});
