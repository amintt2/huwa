/// <reference types="node" />
// Header sniffs (./track-sniff.ts) on real header fixtures with a fake Range reader, and what the
// store (./track-info.ts) makes of them: verified audio languages overriding the release name,
// the release family hint for the next episode.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { classifyDub } from '../audio';
import { clearTrackInfo, httpKey, linkFamily, releaseFamily, releaseStem, torrentKey, trackEntry, verifiedAudio } from '../track-info';
import { inspectRaceBody, readTracks, setTorrentOpener, sniffHttp, sniffTorrent, type RangeReader } from '../track-sniff';

const fx = (name: string) => new Uint8Array(readFileSync(new URL(`../../components/player/engines/__tests__/fixtures/tracks/${name}`, import.meta.url)));

/** A file served by Range: `parts` = { offset: bytes } (what the fake server has). */
function server(parts: Record<number, Uint8Array>): RangeReader & { calls: [number, number][] } {
  const calls: [number, number][] = [];
  const read: RangeReader = async (_url, _h, start, end) => {
    calls.push([start, end]);
    for (const [at, bytes] of Object.entries(parts)) {
      const o = Number(at);
      if (start >= o && start < o + bytes.length) return bytes.subarray(start - o, Math.min(bytes.length, end - o + 1));
    }
    return null;
  };
  return Object.assign(read, { calls });
}

test('HTTP sniff: an untagged release with a French track becomes a dub', async () => {
  clearTrackInfo();
  const url = 'https://cdn.example/Frieren - 05 (1080p).mkv';
  await sniffHttp(url, undefined, null, server({ 0: fx('untagged-fr.mkv.head') }));
  const v = verifiedAudio([httpKey(url)]);
  assert.deepEqual(v, { langs: ['fr'], conclusive: true });
  assert.equal(classifyDub({ title: 'Frieren - 05 (1080p)' }, ['fr'], v).tier, 'dub');
});

test('HTTP sniff: a "MULTI" without French is not a dub; deduplicated', async () => {
  clearTrackInfo();
  const url = 'https://cdn.example/Frieren.S01E05.MULTi.mkv';
  const reader = server({ 0: fx('multi-nofr.mkv.head') });
  await sniffHttp(url, undefined, null, reader);
  await sniffHttp(url, undefined, null, reader);
  assert.equal(reader.calls.length, 1);
  assert.equal(classifyDub({ title: 'Frieren.S01E05.MULTi' }, ['fr'], verifiedAudio([httpKey(url)])).tier, 'no');
});

test('MP4 with the moov at the end: head, then the moov range', async () => {
  const head = fx('nofr-moov-end.mp4.head');
  const reader = server({ 0: head, 102892: fx('nofr-moov-end.mp4.moov') });
  const list = await readTracks('https://x/y.mp4', undefined, reader, 4000);
  assert.deepEqual(list!.tracks.filter((t) => t.kind === 'audio').map((t) => t.lang), ['ja', 'en']);
  assert.equal(reader.calls.length, 2);
  assert.equal(reader.calls[1][0], 102892);
});

test('the race probe body is enough (no extra request)', () => {
  clearTrackInfo();
  const url = 'https://cdn.example/a.mkv';
  inspectRaceBody(url, undefined, fx('multi-fr.mkv.head'), server({}));
  const e = trackEntry(httpKey(url));
  assert.equal(e?.state, 'done');
  assert.deepEqual(verifiedAudio([httpKey(url)]), { langs: ['ja', 'fr'], conclusive: true });
  // An HLS playlist / unknown bytes: nothing to learn, never waited for.
  inspectRaceBody('https://cdn.example/x.m3u8', undefined, new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3\n'), server({}));
  assert.equal(trackEntry(httpKey('https://cdn.example/x.m3u8'))?.state, 'failed');
});

test('torrent sniff through the engine (pre-warm + loopback Range), cached per infoHash + file', async () => {
  clearTrackInfo();
  const opened: unknown[] = [];
  setTorrentOpener(async (t) => {
    opened.push(t);
    return 'http://127.0.0.1:8090/0123456789abcdef0123456789abcdef01234567/3';
  });
  const key = torrentKey('0123456789ABCDEF0123456789ABCDEF01234567', 3, 5);
  const reader = server({ 0: fx('multi-fr.mkv.head') });
  await sniffTorrent(key, { infoHash: '0123456789abcdef0123456789abcdef01234567', fileIdx: 3 }, 'ih:0123456789abcdef0123456789abcdef01234567', reader);
  await sniffTorrent(key, { infoHash: '0123456789abcdef0123456789abcdef01234567', fileIdx: 3 }, null, reader);
  assert.equal(opened.length, 1);
  assert.deepEqual(verifiedAudio([key])?.langs, ['ja', 'fr']);
  // Same pack, next episode (another file): known at once through the release family (a hint).
  const next = torrentKey('0123456789abcdef0123456789abcdef01234567', 4, 6);
  assert.equal(verifiedAudio([next]), null);
  assert.deepEqual(verifiedAudio([next], 'ih:0123456789abcdef0123456789abcdef01234567')?.langs, ['ja', 'fr']);
  setTorrentOpener(null);
});

test('a failed sniff is remembered (no endless waiting)', async () => {
  clearTrackInfo();
  setTorrentOpener(async () => null);
  const key = torrentKey('ffffffffffffffffffffffffffffffffffffffff', null, 2);
  await sniffTorrent(key, { infoHash: 'ffffffffffffffffffffffffffffffffffffffff' }, null, server({}));
  assert.equal(trackEntry(key)?.state, 'failed');
  setTorrentOpener(null);
});

test('release families: the same release for every episode', () => {
  assert.equal(releaseStem('[Group] Frieren - 05 (1080p) [ABCD1234].mkv'), releaseStem('[Group] Frieren - 06 (1080p) [0F0F0F0F].mkv'));
  assert.equal(releaseStem('Frieren.S01E05.MULTi.1080p.WEB.mkv'), releaseStem('Frieren.S01E06.MULTi.1080p.WEB.mkv'));
  assert.notEqual(releaseStem('Frieren.S01E05.MULTi.1080p.mkv'), releaseStem('Frieren.S01E05.VOSTFR.1080p.mkv'));
  assert.equal(releaseFamily({ infoHash: 'ABC', title: 'x' }), 'ih:abc');
  assert.equal(releaseFamily({ addonId: 'a', title: 'x', behaviorHints: { bingeGroup: 'g|1080p' } }), 'bg:a|g|1080p');
  // Learned from the race of one episode, linked to its family.
  clearTrackInfo();
  const url = 'https://cdn.example/Frieren.S01E05.MULTi.1080p.mkv';
  inspectRaceBody(url, undefined, fx('multi-fr.mkv.head'), server({}));
  const family = releaseFamily({ addonId: 'a', title: 'x', behaviorHints: { filename: 'Frieren.S01E05.MULTi.1080p.mkv' } });
  linkFamily([httpKey(url)], family);
  const nextFamily = releaseFamily({ addonId: 'a', title: 'x', behaviorHints: { filename: 'Frieren.S01E06.MULTi.1080p.mkv' } });
  assert.equal(nextFamily, family);
  assert.deepEqual(verifiedAudio([httpKey('https://cdn.example/Frieren.S01E06.MULTi.1080p.mkv')], nextFamily)?.langs, ['ja', 'fr']);
});
