// Invisible proof of work (PLAN.md phase 3): find `nonce` so that
// blake2b(blake2b(payload) || nonce_le32) starts with `bits` zero bits.
// The payload binds the writer core, so a solved nonce cannot be replayed elsewhere.
const b4a = require('b4a')
const sodium = require('sodium-universal')
const { canon } = require('./util')

/** Difficulty table. Deterministic: only depends on the author's state in the view. */
const DIFFICULTY = {
  unknown: 18, // first messages of a key: ~0.3-1 s on a phone
  newcomer: 16, // 1..4 accepted messages
  established: 12, // >= 5 accepted messages
  vouched: 10, // vouched by an established writer
  like: 8,
  dm: 10
}
const MAX_BITS = 24

function difficultyFor(stats) {
  if (!stats) return DIFFICULTY.unknown
  if (stats.vouched) return DIFFICULTY.vouched
  if (stats.n >= 5) return DIFFICULTY.established
  if (stats.n >= 1) return DIFFICULTY.newcomer
  return DIFFICULTY.unknown
}

/** The PoW payload: everything but `nonce` and `auth`, plus the writer key. */
function powPayload(value, writerHex) {
  return b4a.from(canon({ t: value.t, room: value.room, ts: value.ts, body: value.body, w: writerHex }))
}

function leadingZeroBits(buf) {
  let n = 0
  for (const byte of buf) {
    if (byte === 0) {
      n += 8
      continue
    }
    return n + Math.clz32(byte) - 24
  }
  return n
}

function prefix(payload) {
  const buf = b4a.alloc(36)
  sodium.crypto_generichash(buf.subarray(0, 32), payload)
  return buf
}

function check(payload, nonce, bits) {
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > 0xffffffff) return false
  if (bits <= 0) return true
  const buf = prefix(payload)
  const out = b4a.alloc(32)
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(32, nonce, true)
  sodium.crypto_generichash(out, buf)
  return leadingZeroBits(out) >= bits
}

/** Solve synchronously; yields to the event loop every `chunk` tries when `async` is used. */
async function solve(payload, bits, { chunk = 20000 } = {}) {
  if (bits > MAX_BITS) throw new Error('PoW difficulty too high')
  if (bits <= 0) return 0
  const buf = prefix(payload)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const out = b4a.alloc(32)
  for (let nonce = 0; nonce <= 0xffffffff; nonce++) {
    view.setUint32(32, nonce, true)
    sodium.crypto_generichash(out, buf)
    if (leadingZeroBits(out) >= bits) return nonce
    if (nonce % chunk === chunk - 1) await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('PoW not found')
}

module.exports = { DIFFICULTY, MAX_BITS, difficultyFor, powPayload, leadingZeroBits, check, solve }
