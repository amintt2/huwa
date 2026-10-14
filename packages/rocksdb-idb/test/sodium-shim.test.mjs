// The browser sodium shim (spike/shims/sodium.js) must agree with sodium-native byte for byte.
import { Buffer } from 'node:buffer'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const shim = require('../spike/shims/sodium.js')
const native = require('sodium-native')

const rand = (n) => {
  const b = Buffer.alloc(n)
  native.randombytes_buf(b)
  return b
}

test('crypto_scalarmult_ed25519_noclamp matches sodium-native (Noise DH of noise-curve-ed)', () => {
  for (let i = 0; i < 20; i++) {
    const pk = Buffer.alloc(32)
    const sk = Buffer.alloc(64)
    native.crypto_sign_keypair(pk, sk)
    const h = Buffer.alloc(64)
    native.crypto_hash_sha512(h, rand(32))
    const scalar = h.subarray(0, 32)
    scalar[0] &= 248
    scalar[31] &= 127
    scalar[31] |= 64
    const a = Buffer.alloc(32)
    const b = Buffer.alloc(32)
    native.crypto_scalarmult_ed25519_noclamp(a, scalar, pk)
    shim.crypto_scalarmult_ed25519_noclamp(b, scalar, pk)
    assert.equal(b.toString('hex'), a.toString('hex'))
  }
  assert.throws(() => shim.crypto_scalarmult_ed25519_noclamp(Buffer.alloc(32), rand(32), Buffer.alloc(32)))
})

test('XChaCha20-Poly1305 IETF matches sodium-native both ways', () => {
  for (const len of [0, 1, 63, 64, 1000]) {
    const k = rand(32)
    const npub = rand(24)
    const m = rand(len)
    const ad = len % 2 ? rand(13) : null
    const c1 = Buffer.alloc(len + 16)
    const c2 = Buffer.alloc(len + 16)
    native.crypto_aead_xchacha20poly1305_ietf_encrypt(c1, m, ad, null, npub, k)
    shim.crypto_aead_xchacha20poly1305_ietf_encrypt(c2, m, ad, null, npub, k)
    assert.equal(c2.toString('hex'), c1.toString('hex'))
    const back = Buffer.alloc(len)
    shim.crypto_aead_xchacha20poly1305_ietf_decrypt(back, null, c1, ad, npub, k)
    assert.ok(back.equals(m))
    c1[0] ^= 1
    assert.throws(() => shim.crypto_aead_xchacha20poly1305_ietf_decrypt(back, null, c1, ad, npub, k))
  }
})

test('streaming sha512 / sha256 (sodium-hmac) match sodium-native', () => {
  for (const [name, bytes] of [['sha512', 64], ['sha256', 32]]) {
    const parts = [rand(10), rand(200), rand(0), rand(129)]
    const a = Buffer.alloc(bytes)
    const b = Buffer.alloc(bytes)
    const sa = Buffer.alloc(native['crypto_hash_' + name + '_STATEBYTES'])
    const sb = Buffer.alloc(shim['crypto_hash_' + name + '_STATEBYTES'])
    native['crypto_hash_' + name + '_init'](sa)
    shim['crypto_hash_' + name + '_init'](sb)
    for (const p of parts) {
      native['crypto_hash_' + name + '_update'](sa, p)
      shim['crypto_hash_' + name + '_update'](sb, p)
    }
    native['crypto_hash_' + name + '_final'](sa, a)
    shim['crypto_hash_' + name + '_final'](sb, b)
    assert.equal(b.toString('hex'), a.toString('hex'), name)
  }
})

test('pbkdf2-sha512 (bip39 seed) matches sodium-native', async () => {
  const a = Buffer.alloc(64)
  const b = Buffer.alloc(64)
  const pw = Buffer.from('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
  const salt = Buffer.from('mnemonic')
  await native.extension_pbkdf2_sha512_async(a, pw, salt, 2048, 64)
  await shim.extension_pbkdf2_sha512_async(b, pw, salt, 2048, 64)
  assert.equal(b.toString('hex'), a.toString('hex'))
})
