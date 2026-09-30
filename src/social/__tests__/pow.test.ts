/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commentPowPayload, leadingZeroBits, powDifficulty, solvePow, solvePowSync, verifyPow, warmPow } from '../pow';

test('leadingZeroBits', () => {
  assert.equal(leadingZeroBits(new Uint8Array([0x80])), 0);
  assert.equal(leadingZeroBits(new Uint8Array([0x01])), 7);
  assert.equal(leadingZeroBits(new Uint8Array([0, 0x10])), 11);
  assert.equal(leadingZeroBits(new Uint8Array([0, 0])), 16);
});

test('difficulty decreases with trust, never below the floor', () => {
  const stranger = powDifficulty();
  const known = powDifficulty({ accepted: 5 });
  const vouched = powDifficulty({ vouched: true });
  const veteran = powDifficulty({ accepted: 80, vouched: true });
  assert.ok(stranger > known);
  assert.ok(stranger > vouched);
  assert.ok(known > veteran);
  assert.ok(veteran >= 8);
});

for (const algo of ['blake2b', 'sha256'] as const) {
  test(`solve + verify (${algo})`, () => {
    const payload = commentPowPayload('a'.repeat(64), 'ep:1-e1', 'Salut');
    const proof = solvePowSync(payload, 10, algo);
    assert.ok(verifyPow(payload, proof));
    assert.equal(proof.algo, algo);
    // A proof never satisfies a stricter minimum than its own difficulty.
    assert.equal(verifyPow(payload, proof, 11), false);
  });
}

test('tampered payload fails', () => {
  const payload = 'huwa/test';
  const proof = solvePowSync(payload, 12);
  // Probability that the same nonce also works for another payload is 2^-12.
  assert.equal(verifyPow('huwa/tesT', proof), false);
  assert.equal(verifyPow(payload, { ...proof, nonce: -1 }), false);
});

test('async solver yields between batches and matches the sync one', async () => {
  let yields = 0;
  const proof = await solvePow('huwa/async', 11, {
    batch: 64,
    yieldFn: async () => {
      yields++;
    },
  });
  assert.deepEqual(proof, solvePowSync('huwa/async', 11));
  assert.ok(yields > 0);
});

test('async solver can be aborted', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(solvePow('huwa/abort', 30, { signal: ctrl.signal }));
});

test('warmPow reuses the in-flight solve', async () => {
  const a = warmPow('huwa/warm', 8);
  const b = warmPow('huwa/warm', 8);
  assert.equal(a, b);
  assert.ok(verifyPow('huwa/warm', await a));
});
