/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AddonStream } from '@/addons/protocol';
import { streamKey } from '@/addons/quality';

import { downloadability, extensionOf, isExpiredError, pickForDownload, pickSubtitles, REASONS, subtitleExt, whyNotDownloadable } from '../pick';

const st = (name: string, x: Partial<AddonStream>): AddonStream => ({ addonId: 'a', addonName: 'A', name, ...x });
const ctx = { debrid: false, engine: false };

const f1080 = st('1080p', { url: 'https://h/ep.mkv' });
const f720 = st('720p', { url: 'https://h/ep720.mp4' });
const h1080 = st('1080p HLS', { url: 'https://h/master.m3u8' });
const f480 = st('480p', { url: 'https://h/ep480.mp4' });
const web = st('Lecteur', { url: 'https://host/embed/abc' });
const yt = st('Trailer', { ytId: 'abc' });
const tor = st('1080p torrent', { infoHash: 'ABC', fileIdx: 1 });

test('downloadability per kind of stream', () => {
  assert.deepEqual(downloadability(f1080, ctx), { ok: true, kind: 'file' });
  assert.deepEqual(downloadability(h1080, ctx), { ok: true, kind: 'hls' });
  // No HLS download here (simulator / Android): a direct file is taken instead.
  assert.deepEqual(downloadability(h1080, { ...ctx, hls: false }), { ok: false, reason: REASONS.hls });
  assert.equal(pickForDownload([h1080, f720], 'auto', { ...ctx, hls: false })?.stream, f720);
  assert.deepEqual(downloadability(web, ctx), { ok: false, reason: REASONS.web });
  assert.deepEqual(downloadability(yt, ctx), { ok: false, reason: REASONS.youtube });
  assert.deepEqual(downloadability(tor, ctx), { ok: false, reason: REASONS.torrent });
  assert.deepEqual(downloadability(tor, { ...ctx, debrid: true }), { ok: true, kind: 'file' });
  assert.deepEqual(downloadability(tor, { ...ctx, engine: true }), { ok: true, kind: 'torrent' });
});

test('auto keeps the playing source, else the first downloadable one', () => {
  const ranked = [web, f720, f1080];
  assert.equal(pickForDownload(ranked, 'auto', ctx)?.stream, f720);
  assert.equal(pickForDownload(ranked, 'auto', ctx, streamKey(f1080))?.stream, f1080);
  // Playing a web player: falls back to a file.
  assert.equal(pickForDownload(ranked, 'auto', ctx, streamKey(web))?.stream, f720);
});

test('a resolution picks exact, then lower, then higher; files before HLS', () => {
  const ranked = [h1080, f720, f1080, f480];
  assert.equal(pickForDownload(ranked, 1080, ctx)?.stream, f1080);
  assert.equal(pickForDownload(ranked, 720, ctx)?.stream, f720);
  assert.equal(pickForDownload([h1080, f480], 720, ctx)?.stream, f480);
  const up = pickForDownload([h1080], 720, ctx);
  assert.equal(up?.stream, h1080);
  assert.equal(up?.exact, false);
  assert.equal(pickForDownload([web, yt], 'auto', ctx), null);
});

test('reason when nothing is downloadable', () => {
  assert.equal(whyNotDownloadable([web, tor], ctx), REASONS.torrent);
  assert.equal(whyNotDownloadable([web, yt], ctx), REASONS.web);
  assert.equal(whyNotDownloadable([], ctx), REASONS.none);
});

test('extension and expired links', () => {
  assert.equal(extensionOf('https://h/a.mkv?token=1'), 'mkv');
  assert.equal(extensionOf('https://h/master.m3u8'), 'movpkg');
  assert.equal(extensionOf('https://h/dl/123', 'Show.E01.1080p.mkv'), 'mkv');
  assert.equal(extensionOf('https://h/dl/123'), 'mp4');
  assert.ok(isExpiredError(403));
  assert.ok(isExpiredError(undefined, 'HTTP 410 Gone'));
  assert.ok(!isExpiredError(500, 'timeout'));
});

test('subtitles saved: best file of each of the first languages', () => {
  const ranked = [
    { url: 'https://s/fr-exact.srt', lang: 'fre', match: 'hash' },
    { url: 'https://s/en.srt', lang: 'eng' },
    { url: 'https://s/fr-2.srt', lang: 'fr' },
    { url: 'https://s/es.srt', lang: 'spa' },
  ];
  assert.deepEqual(pickSubtitles(ranked, ['fr', 'en', 'es']).map((s) => s.url), ['https://s/fr-exact.srt', 'https://s/en.srt']);
  assert.deepEqual(pickSubtitles(ranked, ['de']), []);
  assert.equal(subtitleExt('https://s/a.ass?x=1'), 'ass');
  assert.equal(subtitleExt('https://s/download/123'), 'srt');
});
