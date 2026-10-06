/// <reference types="node" />
// `.torrent` links and magnet variants in addon answers become torrent streams.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { normalizeStream, isTorrent } from '../protocol';
import { isTorrentFileUrl, parseTorrentFile, resolveTorrentFileStreams } from '../torrent-file';

// Minimal bencode writer for the fixtures (keys sorted, as the spec requires).
type B = number | string | Uint8Array | B[] | { [k: string]: B };
function enc(v: B): Uint8Array {
  const te = new TextEncoder();
  const cat = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  if (typeof v === 'number') return te.encode(`i${v}e`);
  if (typeof v === 'string') return cat([te.encode(`${te.encode(v).length}:`), te.encode(v)]);
  if (v instanceof Uint8Array) return cat([te.encode(`${v.length}:`), v]);
  if (Array.isArray(v)) return cat([te.encode('l'), ...v.map(enc), te.encode('e')]);
  return cat([te.encode('d'), ...Object.keys(v).sort().flatMap((k) => [enc(k), enc(v[k])]), te.encode('e')]);
}

const pieces = new Uint8Array(40).fill(7);
const packInfo = {
  files: [
    { length: 734003200, path: ['Show - 01 [1080p].mkv'] },
    { length: 2048, path: ['Extras', 'Show - 01.nfo'] },
  ],
  name: 'Show S01 [Grp]',
  'piece length': 1048576,
  pieces,
};
const packTorrent = enc({
  announce: 'udp://tracker.example:1337/announce',
  'announce-list': [['udp://tracker.example:1337/announce'], ['https://t2.example/announce', 'dht://nope']],
  info: packInfo,
});

test('parses a .torrent: info hash over the exact info bytes, trackers, files', () => {
  const t = parseTorrentFile(packTorrent);
  assert.equal(t.infoHash, createHash('sha1').update(enc(packInfo)).digest('hex'));
  assert.deepEqual(t.trackers, ['udp://tracker.example:1337/announce', 'https://t2.example/announce']);
  assert.equal(t.name, 'Show S01 [Grp]');
  assert.deepEqual(t.files, [
    { path: 'Show S01 [Grp]/Show - 01 [1080p].mkv', length: 734003200 },
    { path: 'Show S01 [Grp]/Extras/Show - 01.nfo', length: 2048 },
  ]);
  const single = parseTorrentFile(enc({ info: { length: 5, name: 'a.mkv', 'piece length': 16384, pieces: pieces.subarray(0, 20) } }));
  assert.deepEqual(single.files, [{ path: 'a.mkv', length: 5 }]);
  assert.deepEqual(single.trackers, []);
  assert.throws(() => parseTorrentFile(new TextEncoder().encode('<html>login</html>')));
  assert.throws(() => parseTorrentFile(enc({ announce: 'udp://x' })));
});

test('.torrent links are recognized and resolved into torrent streams', async () => {
  assert.ok(isTorrentFileUrl('https://indexer.example/dl/Show%20-%2001.torrent'));
  assert.ok(isTorrentFileUrl('https://jackett.example/dl/nyaa/?jackett_apikey=x&path=abc&file=Show.torrent'));
  assert.ok(!isTorrentFileUrl('https://cdn.example/Show.mkv'));
  assert.ok(!isTorrentFileUrl('magnet:?xt=urn:btih:abc'));

  const fetched: string[] = [];
  const fakeFetch = (async (url: string) => {
    fetched.push(url);
    if (url.includes('broken')) return new Response('nope', { status: 404 });
    return new Response(packTorrent.slice().buffer as ArrayBuffer, { status: 200, headers: { 'content-length': String(packTorrent.length) } });
  }) as unknown as typeof fetch;
  const out = await resolveTorrentFileStreams(
    [
      { name: 'Direct', url: 'https://cdn.example/a.mp4' },
      { name: 'Pack', title: 'Show S01', url: 'https://indexer.example/dl/pack.torrent', fileIdx: 0, behaviorHints: { bingeGroup: 'g' } },
      { name: 'Dead', url: 'https://indexer.example/dl/broken.torrent' },
    ],
    fakeFetch,
  );
  assert.equal(fetched.length, 2);
  assert.equal(out.length, 2, 'unreadable .torrent links are dropped');
  assert.equal(out[0].url, 'https://cdn.example/a.mp4');
  const t = out[1];
  assert.ok(isTorrent(t));
  assert.equal(t.infoHash, parseTorrentFile(packTorrent).infoHash);
  assert.equal(t.fileIdx, 0);
  assert.equal(t.title, 'Show S01');
  assert.deepEqual(t.behaviorHints, { bingeGroup: 'g' });
  assert.deepEqual(t.sources, ['tracker:udp://tracker.example:1337/announce', 'tracker:https://t2.example/announce']);
});

test('magnets: base32 hashes and magnet externalUrl become torrents', () => {
  // BEP 9 base32 form of 0123456789abcdef0123456789abcdef01234567.
  const b32 = normalizeStream({ url: 'magnet:?xt=urn:btih:AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH' })!;
  assert.equal(b32.infoHash, '0123456789abcdef0123456789abcdef01234567');
  const ext = normalizeStream({ name: 'P2P', externalUrl: 'magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=x' })!;
  assert.ok(isTorrent(ext));
  assert.equal(ext.externalUrl, undefined);
  assert.equal(ext.infoHash, '0123456789abcdef0123456789abcdef01234567');
  // A web page stays a web page.
  assert.equal(normalizeStream({ externalUrl: 'https://example.com/watch' })!.infoHash, undefined);
});
