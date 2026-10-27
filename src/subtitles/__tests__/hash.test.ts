/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openSubtitlesHash, totalFromContentRange } from '../hash';

/** Reference implementation (BigInt), straight from the OpenSubtitles description. */
function reference(size: number, head: Uint8Array, tail: Uint8Array): string {
  let h = BigInt(size);
  for (const buf of [head, tail]) {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i + 8 <= buf.byteLength; i += 8) h = (h + v.getBigUint64(i, true)) & ((1n << 64n) - 1n);
  }
  return h.toString(16).padStart(16, '0');
}

function random(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

test('matches the 64-bit reference, carries and overflow included', () => {
  for (const [size, seed] of [[734003200, 1], [12_884_901_888, 7], [131072, 42]] as const) {
    const head = random(65536, seed);
    const tail = random(65536, seed + 1);
    assert.equal(openSubtitlesHash(size, head, tail), reference(size, head, tail));
  }
  const ones = new Uint8Array(65536).fill(0xff);
  assert.equal(openSubtitlesHash(2 ** 40, ones, ones), reference(2 ** 40, ones, ones));
});

test('total size from Content-Range', () => {
  assert.equal(totalFromContentRange('bytes 0-65535/734003200'), 734003200);
  assert.equal(totalFromContentRange('bytes 0-65535/*'), null);
  assert.equal(totalFromContentRange(null), null);
});
