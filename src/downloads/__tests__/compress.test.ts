/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bitsPerPixel, canCompressNow, decideCompression, estimateSaving, targetVideoBps, verifyOutput, type MediaInfo } from '../compress';

const MB = 1024 * 1024;
// A typical web release: 24 min, 1080p H.264 at ~6 Mb/s (≈ 1,05 GB).
const web1080: MediaInfo = { container: 'mp4', codec: 'avc1', width: 1920, height: 1080, durationSec: 1440, sizeBytes: (6e6 * 1440) / 8, fps: 23.976 };

test('targets grow with resolution, fps and mode', () => {
  assert.ok(targetVideoBps(1080, 'balanced') > targetVideoBps(720, 'balanced'));
  assert.ok(targetVideoBps(1080, 'max') < targetVideoBps(1080, 'balanced'));
  assert.ok(targetVideoBps(1080, 'balanced', 60) > targetVideoBps(1080, 'balanced', 24));
  assert.equal(targetVideoBps(1080, 'balanced', 23.976), 2_200_000);
});

test('a fat H.264 1080p file is compressed with a big saving', () => {
  const d = decideCompression(web1080, 'balanced');
  assert.equal(d.compress, true);
  assert.ok(d.compress && d.saving > 0.55 && d.saving < 0.7, String(d.saving));
  const m = decideCompression(web1080, 'max');
  assert.ok(m.compress && m.saving > (d.compress ? d.saving : 0));
});

test('already lean files, unreadable containers and small gains are kept', () => {
  const hevc = { ...web1080, codec: 'hvc1', sizeBytes: (1.8e6 * 1440) / 8 };
  assert.ok(bitsPerPixel(hevc) < 0.08);
  const a = decideCompression(hevc, 'balanced');
  assert.equal(a.compress, false);
  assert.match(a.reason, /HEVC/);
  const mkv = decideCompression({ ...web1080, container: 'mkv' }, 'balanced');
  assert.equal(mkv.compress, false);
  assert.ok(!mkv.compress && mkv.unsupported);
  // H.264 at 2.6 Mb/s: balanced would save < 25 %.
  const lean = decideCompression({ ...web1080, sizeBytes: (2.6e6 * 1440) / 8 }, 'balanced');
  assert.equal(lean.compress, false);
  assert.match(lean.reason, /trop faible/);
  assert.equal(decideCompression(web1080, 'off').compress, false);
  assert.equal(decideCompression({ ...web1080, durationSec: 0 }, 'balanced').compress, false);
  assert.equal(decideCompression({ ...web1080, container: 'movpkg' }, 'balanced').compress, false);
});

test('MP4s the encoder cannot read keep their original (played with mpv)', () => {
  for (const [codecs, why] of [
    [['avc1', 'dts'], /DTS/],
    [['avc1', 'mp3'], /MP3/],
    [['avc1', 'truehd'], /TrueHD/],
    [['avc1', 'h264-hi10', 'aac'], /Hi10P/],
    [['mp4v', 'aac'], /MPEG-4 Part 2/],
    [['hev1', 'aac'], /hev1/],
  ] as const) {
    const d = decideCompression({ ...web1080, codecs: [...codecs] }, 'balanced');
    assert.ok(!d.compress && d.unsupported, codecs.join());
    assert.match(d.reason, why);
    assert.match(d.reason, /original est gardé/);
  }
  assert.equal(decideCompression({ ...web1080, codecs: ['avc1', 'aac'] }, 'balanced').compress, true);
  assert.equal(decideCompression({ ...web1080, codecs: ['avc1', 'eac3'] }, 'balanced').compress, true);
});

test('power rules', () => {
  assert.ok(canCompressNow({ batteryLevel: 0.3, charging: true, lowPower: false }));
  assert.ok(canCompressNow({ batteryLevel: 0.8, charging: false, lowPower: false }));
  assert.ok(!canCompressNow({ batteryLevel: 0.4, charging: false, lowPower: false }));
  assert.ok(!canCompressNow({ batteryLevel: 0.9, charging: true, lowPower: true }));
  assert.ok(!canCompressNow(null));
});

test('output verification', () => {
  const input = { durationSec: 1440, sizeBytes: 1000 * MB };
  assert.equal(verifyOutput(input, { durationSec: 1440.2, sizeBytes: 400 * MB }), null);
  assert.match(verifyOutput(input, { durationSec: 1200, sizeBytes: 400 * MB })!, /durée/);
  assert.match(verifyOutput(input, { durationSec: 1440, sizeBytes: 1200 * MB })!, /plus petit/);
  assert.match(verifyOutput(input, { durationSec: 1440, sizeBytes: 0 })!, /vide/);
});

test('settings estimate sums only compressible downloads', () => {
  const items = [
    { container: 'mp4', durationSec: 1440, sizeBytes: web1080.sizeBytes },
    { container: 'mkv', durationSec: 1440, sizeBytes: web1080.sizeBytes },
    { container: 'mp4', durationSec: 1440, sizeBytes: web1080.sizeBytes, compressed: true },
  ];
  const saved = estimateSaving(items, 'balanced');
  assert.ok(saved > 0.55 * web1080.sizeBytes && saved < 0.7 * web1080.sizeBytes);
  assert.equal(estimateSaving(items, 'off'), 0);
});
