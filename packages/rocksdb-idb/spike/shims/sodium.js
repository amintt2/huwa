// Browser `sodium-native`: sodium-javascript 0.8 plus what the Huwa stack needs and it lacks
// (found by running the node in Chromium; cross-checked against sodium-native by
// test/sodium-shim.test.mjs):
//   crypto_scalarmult_ed25519_noclamp   noise-curve-ed: every Noise handshake (secret-stream)
//   crypto_aead_xchacha20poly1305_ietf_* blind-pairing-core: pairing invites / requests
//   extension_pbkdf2_sha512_async        bip39-mnemonic: identity from the recovery phrase
const sodium = require('sodium-javascript')
const { crypto_core_hchacha20 } = require('sodium-javascript/internal/hchacha20')
const { ed25519 } = require('@noble/curves/ed25519.js')
const { pbkdf2Async } = require('@noble/hashes/pbkdf2.js')
const { sha512 } = require('@noble/hashes/sha2.js')

const out = Object.assign({}, sodium)

const L = ed25519.Point.Fn.ORDER

function le(bytes) {
  let n = 0n
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i])
  return n
}

out.crypto_scalarmult_ed25519_BYTES = 32
out.crypto_scalarmult_ed25519_SCALARBYTES = 32

/** q = n·P without clamping (libsodium clears the top bit of n; P must be a valid point). */
out.crypto_scalarmult_ed25519_noclamp = function (q, n, p) {
  const t = Uint8Array.from(n)
  t[31] &= 127
  const s = le(t) % L
  if (s === 0n) throw new Error('could not compute scalar mult')
  let P
  try {
    P = ed25519.Point.fromBytes(p)
    P.assertValidity()
  } catch {
    throw new Error('could not compute scalar mult')
  }
  if (P.isSmallOrder() || !P.isTorsionFree()) throw new Error('could not compute scalar mult')
  const Q = P.multiply(s)
  if (Q.is0()) throw new Error('could not compute scalar mult')
  q.set(Q.toBytes())
}

out.crypto_aead_xchacha20poly1305_ietf_ABYTES = 16
out.crypto_aead_xchacha20poly1305_ietf_KEYBYTES = 32
out.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES = 24
out.crypto_aead_xchacha20poly1305_ietf_NSECBYTES = 0
out.crypto_aead_xchacha20poly1305_ietf_MESSAGEBYTES_MAX = Number.MAX_SAFE_INTEGER

// XChaCha20-Poly1305 = ChaCha20-Poly1305-IETF with key HChaCha20(k, npub[0..16]) and nonce
// 0x00000000 || npub[16..24] (draft-irtf-cfrg-xchacha, libsodium's construction).
function subkeyAndNonce(npub, k) {
  if (npub.byteLength !== 24) throw new Error('npub must be 24 bytes')
  const subkey = new Uint8Array(32)
  crypto_core_hchacha20(subkey, npub.subarray(0, 16), k, null)
  const nonce = new Uint8Array(12)
  nonce.set(npub.subarray(16, 24), 4)
  return { subkey, nonce }
}

out.crypto_aead_xchacha20poly1305_ietf_keygen = function (k) {
  sodium.randombytes_buf(k)
}

out.crypto_aead_xchacha20poly1305_ietf_encrypt = function (c, m, ad, nsec, npub, k) {
  const { subkey, nonce } = subkeyAndNonce(npub, k)
  return sodium.crypto_aead_chacha20poly1305_ietf_encrypt(c, m, ad, nsec, nonce, subkey)
}

out.crypto_aead_xchacha20poly1305_ietf_decrypt = function (m, nsec, c, ad, npub, k) {
  const { subkey, nonce } = subkeyAndNonce(npub, k)
  return sodium.crypto_aead_chacha20poly1305_ietf_decrypt(m, nsec, c, ad, nonce, subkey)
}

out.extension_pbkdf2_sha512_async = async function (output, password, salt, iter, outlen) {
  const dk = await pbkdf2Async(sha512, password, salt, { c: iter, dkLen: outlen })
  output.set(dk)
}

out.extension_pbkdf2_sha512 = function (output, password, salt, iter, outlen) {
  const { pbkdf2 } = require('@noble/hashes/pbkdf2.js')
  output.set(pbkdf2(sha512, password, salt, { c: iter, dkLen: outlen }))
}

// Streaming SHA-2 (sodium-hmac, used by keet-identity-key to derive the identity from the phrase).
// libsodium keeps the state in a caller buffer; here the buffer only identifies a noble hasher.
const { sha256 } = require('@noble/hashes/sha2.js')
const states = new WeakMap()
function streaming(name, hash, statebytes) {
  if (typeof out['crypto_hash_' + name + '_init'] === 'function') return
  out['crypto_hash_' + name + '_STATEBYTES'] = statebytes
  out['crypto_hash_' + name + '_init'] = (state) => {
    states.set(state, hash.create())
  }
  out['crypto_hash_' + name + '_update'] = (state, data) => {
    states.get(state).update(data)
  }
  out['crypto_hash_' + name + '_final'] = (state, output) => {
    output.set(states.get(state).digest())
    states.delete(state)
  }
}
streaming('sha512', sha512, 208)
streaming('sha256', sha256, 104)

module.exports = out
