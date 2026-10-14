// The browser shims (src/p2p/web/shims/) must agree with sodium-native / Node byte for byte.
// test/register.cjs puts packages/p2p-web/node_modules on the resolution path: the shims require
// sodium-javascript and blake2b-wasm, which only the browser bundle ships.
import { Buffer } from 'node:buffer'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const shim = require('../../../src/p2p/web/shims/sodium.js')
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

test('crypto_generichash on blake2b-wasm matches sodium-native (PoW, discovery keys)', async () => {
  assert.equal(await shim.blake2bWasm(), true, 'WASM blake2b loaded')
  for (const [outLen, keyLen, len] of [[32, 0, 0], [32, 0, 110], [64, 0, 1000], [16, 32, 7], [32, 64, 300]]) {
    const input = rand(len)
    const key = keyLen ? rand(keyLen) : undefined
    const a = Buffer.alloc(outLen)
    const b = Buffer.alloc(outLen)
    native.crypto_generichash(a, input, key)
    shim.crypto_generichash(b, input, key)
    assert.equal(b.toString('hex'), a.toString('hex'), outLen + '/' + keyLen + '/' + len)
  }
  const parts = [rand(3), rand(64), rand(0), rand(200)]
  const a = Buffer.alloc(32)
  const b = Buffer.alloc(32)
  native.crypto_generichash_batch(a, parts)
  shim.crypto_generichash_batch(b, parts)
  assert.equal(b.toString('hex'), a.toString('hex'), 'batch')
})

test('PoW nonces found with sodium-native verify with the shim', async () => {
  const pow = require('../../../src/p2p/worklet/pow.js')
  const payload = pow.commentPowPayload('ab'.repeat(32), 'ep:12-e3', 'Un commentaire')
  const nonce = await pow.solve(payload, 12)
  const head = Buffer.from(payload)
  const buf = Buffer.concat([head, Buffer.alloc(4)])
  buf.writeUInt32BE(nonce, head.length)
  const out = Buffer.alloc(32)
  shim.crypto_generichash(out, buf)
  assert.ok(pow.leadingZeroBits(out) >= 12)
})

test('globals shim: setImmediate keeps order and arguments; Buffer polyfill', async () => {
  const saved = { setImmediate: globalThis.setImmediate, clearImmediate: globalThis.clearImmediate }
  delete globalThis.setImmediate
  try {
    require('../../../src/p2p/web/shims/globals.js')
    assert.notEqual(globalThis.setImmediate, saved.setImmediate)
    const order = []
    const keepAlive = setTimeout(() => {}, 5000) // the shim's port is unref'd in Node
    await new Promise((resolve) => {
      globalThis.setImmediate(() => order.push(1))
      globalThis.setImmediate((x) => {
        order.push(x)
        resolve()
      }, 2)
    })
    clearTimeout(keepAlive)
    assert.deepEqual(order, [1, 2])
  } finally {
    globalThis.setImmediate = saved.setImmediate
    globalThis.clearImmediate = saved.clearImmediate
  }
  const B = require('buffer').Buffer
  const b = B.alloc(4)
  b.writeUInt32BE(0x01020304)
  assert.equal(b.toString('hex'), '01020304')
})
