// Sealed boxes for direct messages (PLAN.md phase 5, minimum acceptable level):
// crypto_box_seal = X25519 with a fresh ephemeral key per message + XSalsa20-Poly1305.
// A relay (blind peer) replicating the DM base sees ciphertext only.
const b4a = require('b4a')
const sodium = require('sodium-universal')

function boxKeyPair(seed) {
  const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_box_seed_keypair(publicKey, secretKey, seed)
  return { publicKey, secretKey }
}

function seal(message, publicKey) {
  const m = b4a.from(message)
  const c = b4a.alloc(m.byteLength + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(c, m, publicKey)
  return c
}

function open(ciphertext, keyPair) {
  if (ciphertext.byteLength < sodium.crypto_box_SEALBYTES) return null
  const m = b4a.alloc(ciphertext.byteLength - sodium.crypto_box_SEALBYTES)
  return sodium.crypto_box_seal_open(m, ciphertext, keyPair.publicKey, keyPair.secretKey) ? m : null
}

module.exports = { boxKeyPair, seal, open }
