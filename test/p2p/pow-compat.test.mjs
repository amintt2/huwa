// The worklet PoW (sodium) must match src/social/pow.ts (noble) used by the `local` implementation.
import test from 'node:test'
import assert from 'node:assert/strict'
import powMod from '../../src/p2p/worklet/pow.js'
import * as social from '../../src/social/pow.ts'

test('worklet and social PoW agree (payload, difficulty, hash)', async () => {
  const payload = social.commentPowPayload('ab'.repeat(32), 'ep:12-e3', 'Héhé 😀')
  assert.equal(powMod.commentPowPayload('ab'.repeat(32), 'ep:12-e3', 'Héhé 😀'), payload)
  for (const accepted of [0, 4, 5, 49, 50, 200]) {
    for (const vouched of [false, true]) {
      assert.equal(powMod.powDifficulty({ accepted, vouched }), social.powDifficulty({ accepted, vouched }))
    }
  }
  const proof = social.solvePowSync(payload, 12)
  assert.ok(powMod.check(payload, proof.nonce, 12), 'social nonce verifies in the worklet')
  const nonce = await powMod.solve(payload, 12)
  assert.ok(social.verifyPow(payload, { nonce, bits: 12, algo: 'blake2b' }), 'worklet nonce verifies in social')
  assert.equal(nonce, proof.nonce, 'both find the same first nonce')
})
