/// <reference types="node" />
// Engine policy: container/codec detection and the AVPlayer/ExoPlayer vs mpv decision.
// Fixtures = first 4 KiB of files generated with ffmpeg from Sintel (© Blender Foundation, CC-BY 3.0).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { containerFromMime, containerFromUrl, decideEngine, sniff, type DeviceCaps } from '../policy';

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
