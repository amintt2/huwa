/// <reference types="node" />
// Engine policy: container/codec detection and the AVPlayer/ExoPlayer vs mpv decision.
// Fixtures = first 4 KiB of files generated with ffmpeg: `sintel-*` from Sintel (© Blender
// Foundation, CC-BY 3.0), the others by scripts/format-samples/generate.sh (test patterns only).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { conclusiveWithoutSniff, containerFromMime, containerFromUrl, decideEngine, mp4Codecs, mp4MoovRange, nativeGap, probeBytes, sniff, type DeviceCaps } from '../policy';
import { probeSource, probeWithoutRequest } from '../probe';

const head = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}.head`, import.meta.url)));

const iphone: DeviceCaps = { platform: 'ios', mpvAvailable: true, hw: { av1: false, hevc: true, vp9: false } };
const iphoneAv1: DeviceCaps = { ...iphone, hw: { ...iphone.hw, av1: true } };
const android: DeviceCaps = { platform: 'android', mpvAvailable: true, hw: {} };
const noMpv: DeviceCaps = { ...iphone, mpvAvailable: false };

test('container from URL extension (query, fragment, encoding)', () => {
  assert.equal(containerFromUrl('https://x.test/a/Ep%2001%20[1080p].mkv?token=1#t=3'), 'mkv');
  assert.equal(containerFromUrl('http://127.0.0.1:8081/stream/0/video.WEBM'), 'webm');
  assert.equal(containerFromUrl('https://cdn.test/master.m3u8'), 'hls');
  assert.equal(containerFromUrl('https://cdn.test/file.mp4'), 'mp4');
  assert.equal(containerFromUrl('https://cdn.test/file.avi'), 'avi');
  assert.equal(containerFromUrl('https://debrid.test/dl/ABCDEF'), 'unknown');
});

test('container from Content-Type', () => {
  assert.equal(containerFromMime('video/x-matroska'), 'mkv');
  assert.equal(containerFromMime('video/webm; codecs="vp9"'), 'webm');
  assert.equal(containerFromMime('application/vnd.apple.mpegurl'), 'hls');
  assert.equal(containerFromMime('video/mp4'), 'mp4');
  assert.equal(containerFromMime('application/octet-stream'), 'unknown');
  assert.equal(containerFromMime(null), 'unknown');
});

test('sniffs real file headers', () => {
  const mkv = sniff(head('sintel-hevc10.mkv'));
  assert.equal(mkv.container, 'mkv');
  assert.ok(mkv.codecs.includes('hevc') && mkv.codecs.includes('ass'));
  const webm = sniff(head('sintel-vp9.webm'));
  assert.equal(webm.container, 'webm');
  assert.ok(webm.codecs.includes('vp09'));
  assert.deepEqual(sniff(head('sintel-h264.mp4')).container, 'mp4');
  assert.ok(sniff(head('av1.mp4')).codecs.includes('av01'));
  assert.ok(sniff(head('hev1.mp4')).codecs.includes('hev1'));
  assert.ok(sniff(head('vp9.mp4')).codecs.includes('vp09'));
  assert.equal(sniff(new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3\n')).container, 'hls');
  assert.equal(sniff(new Uint8Array(8)).container, 'unknown');
});

test('iPhone: AVPlayer by default, mpv for what it cannot play', () => {
  const d = (name: string, caps = iphone) => decideEngine('auto', caps, sniff(head(name)));
  assert.equal(d('sintel-h264.mp4').engine, 'native');
  assert.deepEqual(d('sintel-hevc10.mkv'), { engine: 'mpv', reason: 'conteneur MKV' });
  assert.deepEqual(d('sintel-vp9.webm'), { engine: 'mpv', reason: 'conteneur WebM' });
  assert.deepEqual(d('vp9.mp4'), { engine: 'mpv', reason: 'codec VP9' });
  assert.deepEqual(d('hev1.mp4'), { engine: 'mpv', reason: 'HEVC hev1' });
  // AV1: software (mpv/dav1d) only without a hardware decoder (A17 Pro / M3 and later have one).
  assert.deepEqual(d('av1.mp4'), { engine: 'mpv', reason: 'AV1 sans décodeur matériel' });
  assert.equal(d('av1.mp4', iphoneAv1).engine, 'native');
  assert.equal(decideEngine('auto', iphone, { container: 'hls', codecs: [], via: 'ext' }).engine, 'native');
  assert.equal(decideEngine('auto', iphone, { container: 'unknown', codecs: [], via: 'none' }).engine, 'native');
  assert.equal(decideEngine('auto', iphone, null).engine, 'native');
});

test('Android: ExoPlayer already plays MKV/WebM', () => {
  assert.equal(decideEngine('auto', android, sniff(head('sintel-hevc10.mkv'))).engine, 'native');
  assert.equal(decideEngine('auto', android, sniff(head('sintel-vp9.webm'))).engine, 'native');
  assert.equal(decideEngine('auto', android, { container: 'wmv', codecs: [], via: 'ext' }).engine, 'mpv');
});

test('the setting wins, and nothing breaks without mpv', () => {
  const mkv = sniff(head('sintel-hevc10.mkv'));
  assert.equal(decideEngine('native', iphone, mkv).engine, 'native');
  assert.equal(decideEngine('mpv', iphone, sniff(head('sintel-h264.mp4'))).engine, 'mpv');
  assert.equal(decideEngine('auto', noMpv, mkv).engine, 'native');
  assert.equal(decideEngine('mpv', noMpv, mkv).engine, 'native');
});

test('built-in torrent engine: straight to mpv unless the URL says MP4, never a sniff that waits for piece 0', async () => {
  const h = 'cd'.repeat(20);
  const bare = `http://127.0.0.1:50000/${h}/0`;
  const mkvUrl = `http://127.0.0.1:50000/${h}/0.mkv`;
  const mp4Url = `http://127.0.0.1:50000/${h}/0.mp4`;
  // No extension (metadata not known yet): decided without any request.
  const p = probeWithoutRequest(bare)!;
  assert.deepEqual(p, { container: 'unknown', codecs: [], via: 'ext', torrent: true });
  assert.deepEqual(decideEngine('auto', iphone, p), { engine: 'mpv', reason: 'moteur torrent' });
  // probeSource answers at once (there is no XMLHttpRequest here: a request would throw).
  assert.deepEqual(await probeSource(bare), p);
  assert.equal(decideEngine('auto', iphone, probeWithoutRequest(mkvUrl)).engine, 'mpv');
  // MP4 still needs its sample entries (hvc1 vs hev1, AV1…): sniffed.
  assert.equal(probeWithoutRequest(mp4Url), null);
  assert.equal(decideEngine('auto', iphone, { ...sniff(head('sintel-h264.mp4')), torrent: true }).engine, 'native');
  // The user's engine setting still wins.
  assert.equal(decideEngine('native', iphone, p).engine, 'native');
  // Other servers: unchanged.
  assert.equal(probeWithoutRequest('https://debrid.test/dl/ABCDEF'), null);
  assert.equal(decideEngine('auto', iphone, { container: 'unknown', codecs: [], via: 'none' }).engine, 'native');
});

// ---------- formats checked on real files (scripts/format-samples: ffmpeg testsrc2 + sine) ----------

const file = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

test('MP4 sample entries: video profile and audio codec', () => {
  const codecs = (name: string) => sniff(head(name)).codecs;
  assert.deepEqual(codecs('dts.mp4'), ['avc1', 'dts']);
  assert.deepEqual(codecs('truehd.mp4'), ['avc1', 'truehd']);
  assert.deepEqual(codecs('mp3.mp4'), ['avc1', 'mp3']);
  assert.deepEqual(codecs('opus.mp4'), ['avc1', 'opus']);
  assert.deepEqual(codecs('eac3.mp4'), ['avc1', 'eac3']);
  assert.deepEqual(codecs('hi10p.mp4'), ['avc1', 'h264-hi10', 'aac']);
  assert.deepEqual(codecs('mpeg4asp.mp4'), ['mp4v', 'aac']);
  // 8-bit H.264 is not mistaken for Hi10P.
  assert.ok(!codecs('sintel-h264.mp4').includes('h264-hi10'));
});

test('MP4 with its moov at the end: the second read is located and parsed', () => {
  const h = head('moov-end.mp4');
  // The head alone knows the container, not the tracks.
  assert.equal(sniff(h).container, 'mp4');
  assert.ok(!sniff(h).codecs.includes('aac'));
  // ftyp (32) + free (8) + mdat (72838): the moov starts right after.
  assert.deepEqual(mp4MoovRange(h), { start: 72878, end: 72878 + 2 * 1024 * 1024 - 1 });
  assert.deepEqual(mp4Codecs(file('moov-end.mp4.tail')), ['avc1', 'aac']);
  // Faststart file whose moov fits: nothing more to read. Cut short: the rest of it.
  assert.equal(mp4MoovRange(head('dts.mp4')), null);
  assert.deepEqual(mp4MoovRange(head('dts.mp4').subarray(0, 1024)), { start: 32, end: 32 + 2362 - 1 });
  // A truncated moov still yields what it holds.
  assert.deepEqual(mp4Codecs(head('dts.mp4').subarray(0, 1024)), ['avc1']);
  assert.equal(mp4MoovRange(new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3\n')), null);
});

test('local files (downloads): head + moov read from the disk', () => {
  // The moov-at-end file rebuilt from its two fixtures: head, zeros, moov.
  const h = head('moov-end.mp4');
  const tail = file('moov-end.mp4.tail');
  const whole = new Uint8Array(72878 + tail.length);
  whole.set(h);
  whole.set(tail, 72878);
  const reads: [number, number][] = [];
  const p = probeBytes((start, length) => {
    reads.push([start, length]);
    return whole.subarray(start, start + length);
  });
  assert.equal(p.container, 'mp4');
  assert.ok(p.codecs.includes('aac') && p.codecs.includes('avc1'));
  assert.deepEqual(reads, [[0, 4096], [72878, 2 * 1024 * 1024]]);
  assert.deepEqual(probeBytes(() => null), { container: 'unknown', codecs: [], via: 'none' });
  assert.equal(nativeGap(['avc1', 'aac']), null);
  assert.equal(nativeGap(['hvc1', 'hev1']), null);
});

test('Matroska codec ids, Hi10P from the avcC, other containers by magic', () => {
  const mkv = sniff(head('hi10p-ass.mkv'));
  assert.equal(mkv.container, 'mkv');
  assert.deepEqual(mkv.codecs, ['avc1', 'h264-hi10', 'aac', 'ass']);
  assert.deepEqual(sniff(head('dts.mkv')).codecs, ['avc1', 'dts']);
  assert.ok(!sniff(head('sintel-hevc10.mkv')).codecs.includes('h264-hi10'));
  assert.equal(sniff(head('mpeg2.vob')).container, 'mpeg');
  assert.equal(sniff(head('bluray.m2ts')).container, 'ts');
  assert.equal(sniff(head('xvid.avi')).container, 'avi');
});

test('iPhone: straight to mpv for every format AVPlayer drops or cannot decode', () => {
  const d = (name: string) => decideEngine('auto', iphone, sniff(head(name)));
  // AVFoundation lists no audio track for these (silent video, no error to fall back on).
  assert.deepEqual(d('dts.mp4'), { engine: 'mpv', reason: 'audio DTS' });
  assert.deepEqual(d('mp3.mp4'), { engine: 'mpv', reason: 'audio MP3 dans MP4' });
  assert.deepEqual(d('truehd.mp4'), { engine: 'mpv', reason: 'audio TrueHD' });
  assert.deepEqual(d('hi10p.mp4'), { engine: 'mpv', reason: 'H.264 10 bits (Hi10P)' });
  assert.deepEqual(d('mpeg4asp.mp4'), { engine: 'mpv', reason: 'codec MPEG-4 Part 2 (Xvid/DivX)' });
  // Played by AVFoundation (checked): stay native.
  assert.equal(d('eac3.mp4').engine, 'native');
  assert.equal(d('opus.mp4').engine, 'native');
  assert.equal(decideEngine('auto', iphone, { container: 'mp4', codecs: ['avc1', 'ac3'], via: 'sniff' }).engine, 'native');
  assert.equal(decideEngine('auto', iphone, { container: 'mp4', codecs: ['hvc1', 'aac'], via: 'sniff' }).engine, 'native');
  // Containers by extension, no request needed.
  for (const url of ['a.avi', 'a.ts', 'a.m2ts', 'a.vob', 'a.mpg', 'a.ogm', 'a.rmvb', 'a.wmv', 'a.flv', 'a.webm', 'a.mpd']) {
    const p = { container: containerFromUrl(`https://x.test/${url}`), codecs: [], via: 'ext' as const };
    assert.equal(decideEngine('auto', iphone, p).engine, 'mpv', url);
    assert.ok(conclusiveWithoutSniff(p), url);
  }
  assert.equal(containerFromUrl('https://x.test/a.3gp'), 'mp4');
  assert.equal(containerFromMime('video/mpeg'), 'mpeg');
});

test('Android: ExoPlayer keeps MKV, mpv only for what MediaCodec cannot decode', () => {
  assert.equal(decideEngine('auto', android, sniff(head('dts.mkv'))).engine, 'mpv');
  assert.equal(decideEngine('auto', android, sniff(head('hi10p-ass.mkv'))).engine, 'mpv');
  assert.equal(decideEngine('auto', android, sniff(head('mp3.mp4'))).engine, 'native');
});
