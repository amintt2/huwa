// Opt-in community playback statistics ("Comparer avec la communauté"), worklet side.
// One public Autobase per UTC month (`stats:YYYY-MM`). Each contribution is appended by a fresh
// writer (random namespace, separate Corestore and swarm key, see node.js): it carries no identity,
// no auth, no device key, and nothing links two contributions or a contribution to a person.
// Body = coarse noisy histograms (src/stats/community.ts, mirrored here; test/p2p/stats.test.mjs
// checks both agree). Validation is strict and deterministic, like every reducer here.
const pow = require('./pow')
const { toHex } = require('./util')

/** Mirrors of src/stats/community.ts. */
const STATS_VERSION = 1
const BUCKET_COUNT = 11
const PATHS = ['http-direct', 'debrid', 'torrent-engine', 'web-player', 'aggregator-playback']
const COUNT_MIN = -16
const COUNT_MAX = 64
const TOTAL_MAX = 200
/** Contributions cost more work than a like: writers are free to create, the PoW is the brake. */
const STATS_BITS = 18
const MAX_STATS_NODE_BYTES = 2048
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const ID = /^[0-9a-f]{32}$/

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k))
const isCount = (v, max) => Number.isInteger(v) && v >= COUNT_MIN && v <= max
const DAY_MS = 86_400_000

function monthOf(ts) {
  const d = new Date(ts)
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')
}

function sizeOk(value) {
  try {
    return JSON.stringify(value).length <= MAX_STATS_NODE_BYTES
  } catch {
    return false
  }
}

function statsBody(b) {
  if (!isObj(b) || !onlyKeys(b, ['id', 'v', 'h', 's'])) return false
  if (typeof b.id !== 'string' || !ID.test(b.id) || b.v !== STATS_VERSION) return false
  if (!Array.isArray(b.s) || b.s.length !== 3 || !b.s.every((n) => isCount(n, TOTAL_MAX))) return false
  if (!isObj(b.h)) return false
  const keys = Object.keys(b.h)
  if (!keys.length || !keys.every((k) => PATHS.includes(k))) return false
  return keys.every((k) => Array.isArray(b.h[k]) && b.h[k].length === BUCKET_COUNT && b.h[k].every((n) => isCount(n, COUNT_MAX)))
}

/**
 * `{ v: 1, t: 'stat', room: 'stats:YYYY-MM', ts, nonce, body }` — no `auth` (unlinkable), the
 * timestamp is a UTC day inside the room's month.
 */
function statsNode(value, month) {
  if (!isObj(value) || !sizeOk(value)) return false
  if (!onlyKeys(value, ['v', 't', 'room', 'ts', 'nonce', 'body'])) return false
  if (value.v !== 1 || value.t !== 'stat' || value.room !== 'stats:' + month) return false
  if (!Number.isInteger(value.ts) || value.ts <= 1e12 || value.ts >= 1e13 || value.ts % DAY_MS !== 0) return false
  if (monthOf(value.ts) !== month) return false
  if (!Number.isInteger(value.nonce) || value.nonce < 0 || value.nonce > 0xffffffff) return false
  return statsBody(value.body)
}

const get = async (view, key) => {
  const node = await view.get(key)
  return node ? node.value : null
}

/** Reducer of a monthly stats room: one contribution per writer, unique ids, PoW checked. */
function createStatsApply(month) {
  if (!MONTH.test(month)) throw new Error('Mois invalide')
  return async function apply(nodes, view, host) {
    for (const node of nodes) {
      const v = node.value
      if (v === null || !statsNode(v, month)) continue
      const w = toHex(node.from.key)
      if (await get(view, 'w/' + w)) continue
      if (await get(view, 's/' + v.body.id)) continue
      if (!pow.check(pow.powPayload(v, w), v.nonce, STATS_BITS)) continue
      await view.put('s/' + v.body.id, { h: v.body.h, s: v.body.s })
      await view.put('w/' + w, 1)
      if (host) {
        if (node.optimistic !== false && host.ackWriter) await host.ackWriter(node.from.key)
        if (host.addWriter) await host.addWriter(node.from.key, { indexer: false })
      }
    }
  }
}

/** Sums the contributions of a room view (same rules as `mergeContributions`). */
function mergeInto(out, value) {
  if (!isObj(value) || !statsBody({ id: '0'.repeat(32), v: STATS_VERSION, h: value.h, s: value.s })) return out
  out.contributions++
  for (const k of Object.keys(value.h)) {
    const acc = out.h[k] || (out.h[k] = new Array(BUCKET_COUNT).fill(0))
    value.h[k].forEach((n, i) => (acc[i] += n))
  }
  value.s.forEach((n, i) => (out.s[i] += n))
  return out
}

module.exports = {
  STATS_VERSION,
  BUCKET_COUNT,
  PATHS,
  COUNT_MIN,
  COUNT_MAX,
  TOTAL_MAX,
  STATS_BITS,
  MONTH,
  DAY_MS,
  monthOf,
  statsBody,
  statsNode,
  createStatsApply,
  mergeInto
}
