// Invisible proof of work (PLAN.md phase 3), worklet side.
// Same algorithm and difficulty table as src/social/pow.ts (used by the `local` implementation):
//   blake2b-256(utf8(payload) || nonce_u32_BE) must start with `bits` zero bits.
// The worklet cannot import TypeScript, so the pure parts are mirrored here;
// test/p2p/pow-compat.test.mjs checks both give identical results.
const b4a = require('b4a')
const sodium = require('sodium-universal')
const { canon } = require('./util')

/** Mirror of `POW` in src/social/pow.ts. */
const POW = {
  base: 16,
  knownAfter: 5,
  knownDiscount: 4,
  vouchDiscount: 2,
  trustedAfter: 50,
  trustedDiscount: 2,
  floor: 8
}

/** Mirror of `powDifficulty` in src/social/pow.ts. */
function powDifficulty({ accepted = 0, vouched = false } = {}) {
  let bits = POW.base
  if (accepted >= POW.knownAfter) bits -= POW.knownDiscount
  if (accepted >= POW.trustedAfter) bits -= POW.trustedDiscount
  if (vouched) bits -= POW.vouchDiscount
  return Math.max(POW.floor, bits)
}

/** Mirror of `commentPowPayload` in src/social/pow.ts (no timestamp: solvable while typing). */
const commentPowPayload = (author, target, text) => `huwa/comment/v1\n${author}\n${target}\n${text}`

const DIFFICULTY = {
  unknown: powDifficulty({ accepted: 0 }),
  established: powDifficulty({ accepted: POW.knownAfter }),
  vouched: powDifficulty({ accepted: 0, vouched: true }),
  like: 8,
  dm: 10
}
const MAX_BITS = 24

/** Difficulty for an author given its stats in the room view (`{ n, vouched }`). */
function difficultyFor(stats) {
  return powDifficulty({ accepted: stats ? stats.n : 0, vouched: !!(stats && stats.vouched) })
}

/** Payload of a room/DM node: comments use the shared payload, others bind the writer core. */
function powPayload(value, writerHex, author) {
  if (value.t === 'comment' && author) return commentPowPayload(author, value.body.target, value.body.text)
  return 'huwa/' + value.t + '/v1\n' + canon({ room: value.room, ts: value.ts, body: value.body, w: writerHex })
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

function hasher(payload) {
  const head = b4a.from(payload)
  const buf = b4a.alloc(head.byteLength + 4)
  buf.set(head)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const out = b4a.alloc(32)
  return (nonce) => {
    view.setUint32(head.byteLength, nonce >>> 0, false)
    sodium.crypto_generichash(out, buf)
    return out
  }
}

function check(payload, nonce, bits) {
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > 0xffffffff) return false
  if (bits <= 0) return true
  return leadingZeroBits(hasher(payload)(nonce)) >= bits
}

/** Yields to the event loop every `chunk` tries so RPC stays responsive. */
async function solve(payload, bits, { chunk = 20000 } = {}) {
  if (bits > MAX_BITS) throw new Error('PoW difficulty too high')
  if (bits <= 0) return 0
  const hash = hasher(payload)
  for (let nonce = 0; nonce <= 0xffffffff; nonce++) {
    if (leadingZeroBits(hash(nonce)) >= bits) return nonce
    if (nonce % chunk === chunk - 1) await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('PoW not found')
}

module.exports = {
  POW,
  DIFFICULTY,
  MAX_BITS,
  powDifficulty,
  commentPowPayload,
  difficultyFor,
  powPayload,
  leadingZeroBits,
  check,
  solve
}
