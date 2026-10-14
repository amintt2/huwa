// HUWA FORK: HyperDHT mutable records (hyperdht/lib/persistent.js signMutable / verifyMutable),
// without pulling hyperdht's persistent store into browser bundles.
const buffer = require('b4a')
const sodium = require('sodium-universal')
const c = require('compact-encoding')
const { NS } = require('hyperdht/lib/constants')
const { mutableSignable } = require('hyperdht/lib/messages')

const MAX_VALUE = 1000 // HyperDHT's own limit for a mutable value

function signable (seq, value) {
  const out = buffer.allocUnsafe(64)
  out.set(NS.MUTABLE_PUT, 0)
  sodium.crypto_generichash(out.subarray(32), c.encode(mutableSignable, { seq, value }))
  return out
}

async function signMutable (seq, value, keyPair) {
  if (keyPair.sign) return keyPair.sign(signable(seq, value))
  if (!keyPair.secretKey) throw new Error('mutablePut needs a secret key or a sign function')
  const signature = buffer.allocUnsafe(64)
  sodium.crypto_sign_detached(signature, signable(seq, value), keyPair.secretKey)
  return signature
}

function verifyMutable (signature, seq, value, publicKey) {
  if (!signature || signature.byteLength !== 64 || !publicKey || publicKey.byteLength !== 32) return false
  return sodium.crypto_sign_verify_detached(signature, signable(seq, value), publicKey)
}

module.exports = { signable, signMutable, verifyMutable, MAX_VALUE }
