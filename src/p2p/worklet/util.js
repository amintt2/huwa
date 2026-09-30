// Small helpers shared by the worklet modules. Runs under Bare and Node.
const b4a = require('b4a')
const sodium = require('sodium-universal')

/** Deterministic JSON: sorted keys, `undefined` dropped. Used for hashes and PoW. */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}

function hash(data, bytes = 32) {
  const out = b4a.alloc(bytes)
  sodium.crypto_generichash(out, typeof data === 'string' ? b4a.from(data) : data)
  return out
}

const toHex = (buf) => b4a.toString(buf, 'hex')
const fromHex = (str) => b4a.from(str, 'hex')

const HEX32 = /^[0-9a-f]{64}$/
const isKey = (s) => typeof s === 'string' && HEX32.test(s)

/** Same rule as `seriesIdOfTarget` in src/store/store.ts. */
function seriesIdOfTarget(target) {
  const id = String(target).split(':')[1] || ''
  return id.split('-')[0]
}

/** Short fingerprint to tell homonyms apart (8 chars, base32 lowercase). */
function fingerprint(keyHex) {
  const h = hash(fromHex(keyHex), 16).subarray(0, 8)
  const alphabet = 'ybndrfg8ejkmcpqxot1uwisza345h769'
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of h) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out.slice(0, 8)
}

const pad = (n, w = 15) => String(n).padStart(w, '0')

module.exports = { canon, hash, toHex, fromHex, isKey, seriesIdOfTarget, fingerprint, pad }
