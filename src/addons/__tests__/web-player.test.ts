/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AddonStream } from '../protocol';
import { detectQuality, playTier, rankStreams, type RankContext } from '../quality';
import {
  clearProbeCache,
  guessFromContentType,
  guessFromUrl,
  hostOf,
  needsProbe,
  probeUrl,
  siteOf,
  webPlayerUrl,
} from '../web-player';

const s = (x: Partial<AddonStream>): AddonStream => ({ addonId: 'a', addonName: 'A', ...x });

test('media links are recognised by extension, player pages by extension or embed path', () => {
  for (const u of [
    'https://cdn.example/v/ep1.m3u8',
    'https://cdn.example/files/Ep%2001.MP4?token=1',
    'https://x.example/a.mkv',
    'https://x.example/a.webm#t=3',
    'https://x.example/a.mov',
    'https://x.example/get?file=episode.mp4&sig=2',
  ]) assert.equal(guessFromUrl(u), 'direct', u);
  for (const u of ['https://host.example/embed/abc123', 'https://host.example/e/abc', 'https://host.example/watch.php?id=4', 'https://host.example/p/player.html'])
    assert.equal(guessFromUrl(u), 'page', u);
  assert.equal(guessFromUrl('https://debrid.example/d/XYZ'), 'unknown');
  // The addon's file name settles an extension-less link.
  assert.equal(guessFromUrl('https://debrid.example/d/XYZ', 'Show S01E01 1080p.mkv'), 'direct');
});

test('content types', () => {
  assert.equal(guessFromContentType('video/mp4'), 'direct');
  assert.equal(guessFromContentType('application/vnd.apple.mpegurl; charset=utf-8'), 'direct');
  assert.equal(guessFromContentType('application/x-mpegURL'), 'direct');
  assert.equal(guessFromContentType('text/html; charset=UTF-8'), 'page');
  assert.equal(guessFromContentType('application/json'), 'unknown');
  assert.equal(guessFromContentType(null), 'unknown');
});

test('web player URL of a stream', () => {
  assert.equal(webPlayerUrl(s({ externalUrl: 'https://host.example/embed/1' })), 'https://host.example/embed/1');
  // Deep links / Stremio links are not web players.
  assert.equal(webPlayerUrl(s({ externalUrl: 'stremio:///detail/series/tt1' })), null);
  assert.equal(webPlayerUrl(s({ externalUrl: 'vlc://x' })), null);
  // A playable url wins over externalUrl; ytId stays YouTube.
  assert.equal(webPlayerUrl(s({ url: 'https://cdn.example/a.mp4', externalUrl: 'https://host.example/p' })), null);
  assert.equal(webPlayerUrl(s({ ytId: 'abc', externalUrl: 'https://youtube.com/watch?v=abc' })), null);
  assert.equal(webPlayerUrl(s({ url: 'https://host.example/embed/9' })), 'https://host.example/embed/9');
  // Extension-less url: decided by probing.
  const u = 'https://host.example/watch/9';
  assert.equal(needsProbe(s({ url: u })), true);
  assert.equal(webPlayerUrl(s({ url: u })), null);
  assert.equal(webPlayerUrl(s({ url: u }), { [u]: 'page' }), u);
  assert.equal(webPlayerUrl(s({ url: u }), { [u]: 'direct' }), null);
  assert.equal(needsProbe(s({ url: u, behaviorHints: { videoSize: 1e9 } })), false);
});

test('host and site', () => {
  assert.equal(hostOf('https://www.Vid.Example.com:8443/embed/1'), 'vid.example.com');
  assert.equal(siteOf('https://cdn2.vid.example.com/x'), 'example.com');
  assert.equal(siteOf('https://player.host.co.uk/x'), 'host.co.uk');
  assert.equal(siteOf('http://127.0.0.1:7000/p'), '127.0.0.1');
  assert.equal(siteOf('http://localhost:7000/p'), 'localhost');
});

test('probing reads Content-Type (HEAD, then a 1-byte GET) and caches', async () => {
  clearProbeCache();
  const calls: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${url}`);
    if (url.endsWith('/page')) return new Response('', { status: 200, headers: { 'content-type': 'text/html' } });
    if (init?.method === 'HEAD') return new Response(null, { status: 405 });
    return new Response('x', { status: 206, headers: { 'content-type': 'video/mp4' } });
  }) as typeof fetch;
  assert.equal(await probeUrl('https://h.example/page', undefined, fake), 'page');
  assert.equal(await probeUrl('https://h.example/file', undefined, fake), 'direct');
  assert.equal(await probeUrl('https://h.example/page', undefined, fake), 'page');
  assert.deepEqual(calls, ['HEAD https://h.example/page', 'HEAD https://h.example/file', 'GET https://h.example/file']);
  const slow = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  assert.equal(await probeUrl('https://h.example/slow', undefined, slow, 20), 'unknown');
  clearProbeCache();
});

const ctx: RankContext = { preferred: 1080, addonOrder: ['a', 'b'], canResolveTorrents: false };

test('web players rank after direct links, keep their quality, before YouTube', () => {
  const web1080 = s({ name: 'Lecteur 1080p', externalUrl: 'https://host.example/embed/1' });
  const web720 = s({ name: 'Lecteur 720p', externalUrl: 'https://other.example/e/2' });
  const direct480 = s({ name: 'MP4 480p', url: 'https://cdn.example/a.mp4' });
  const yt = s({ name: 'Trailer', ytId: 'x' });
  assert.equal(detectQuality(web1080), 1080);
  assert.equal(playTier(web1080, ctx), 2.8);
  assert.equal(playTier(direct480, ctx), 0);
  assert.deepEqual(rankStreams([yt, web720, web1080, direct480], ctx), [direct480, web1080, web720, yt]);
  // A probed HTML url becomes a web player.
  const html = s({ name: 'Serveur 2 1080p', url: 'https://host.example/watch/2' });
  assert.equal(playTier(html, ctx), 0);
  assert.equal(playTier(html, { ...ctx, probed: { 'https://host.example/watch/2': 'page' } }), 2.8);
});
