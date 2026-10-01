// Strict validation of everything that comes from a peer (PLAN.md phase 10).
// Each validator returns true/false and never throws. No clock, no I/O: safe inside `apply`.
const { isKey, seriesIdOfTarget } = require('./util')

const MAX_NODE_BYTES = 8192
const MAX_DM_NODE_BYTES = 48 * 1024

const LIMITS = {
  text: 2000,
  name: 40,
  bio: 300,
  avatar: 512,
  dmText: 4000,
  sealedHex: 2 * (4000 * 4 + 512)
}

const WORK = /^[A-Za-z0-9_.-]{1,64}$/
const TARGET = /^(ep|ch|series):[A-Za-z0-9_.-]{1,80}$/
const ID = /^[0-9a-f]{32}$/
const HEX = /^[0-9a-f]+$/
const LABELS = ['spam', 'abuse', 'spoiler', 'nsfw', 'hide']

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v, max, min = 1) => typeof v === 'string' && v.length >= min && v.length <= max
const isTs = (v) => Number.isInteger(v) && v > 1e12 && v < 1e13
const isBool = (v) => typeof v === 'boolean'
const optional = (v, check) => v === undefined || check(v)
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k))
const isId = (v) => typeof v === 'string' && ID.test(v)
const isNonce = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff
const isAuth = (v) => isObj(v) && onlyKeys(v, ['p', 'h']) && typeof v.p === 'string' && v.p.length <= 2048 && HEX.test(v.p) && isKey(v.h)

function sizeOk(value, max) {
  try {
    return JSON.stringify(value).length <= max
  } catch {
    return false
  }
}

/** Common envelope: `{ v: 1, t, room, ts, nonce?, auth?, body }`. */
function envelope(value, types, max = MAX_NODE_BYTES) {
  if (!isObj(value) || !sizeOk(value, max)) return false
  if (!onlyKeys(value, ['v', 't', 'room', 'ts', 'nonce', 'auth', 'body'])) return false
  if (value.v !== 1 || !types.includes(value.t)) return false
  if (typeof value.room !== 'string' || value.room.length > 80) return false
  if (!isTs(value.ts) || !isObj(value.body)) return false
  if (!optional(value.nonce, isNonce) || !optional(value.auth, isAuth)) return false
  return true
}

// ---- comment rooms --------------------------------------------------------

function commentBody(b, work) {
  return (
    onlyKeys(b, ['id', 'target', 'parentId', 'text', 'spoiler', 'timestamp', 'fromAnime', 'name']) &&
    isId(b.id) &&
    typeof b.target === 'string' &&
    TARGET.test(b.target) &&
    seriesIdOfTarget(b.target) === work &&
    optional(b.parentId, isId) &&
    isStr(b.text, LIMITS.text) &&
    b.text.trim().length > 0 &&
    isBool(b.spoiler) &&
    optional(b.timestamp, (t) => typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= 86400) &&
    optional(b.fromAnime, isBool) &&
    isStr(b.name, LIMITS.name)
  )
}

function roomNode(value, work) {
  if (!envelope(value, ['comment', 'like', 'edit', 'delete', 'vouch', 'bind', 'revoke'])) return false
  if (value.room !== 'work:' + work) return false
  const b = value.body
  switch (value.t) {
    case 'comment':
      return isNonce(value.nonce) && commentBody(b, work)
    case 'like':
      return isNonce(value.nonce) && onlyKeys(b, ['id', 'on']) && isId(b.id) && isBool(b.on)
    case 'edit':
      return (
        isNonce(value.nonce) &&
        onlyKeys(b, ['id', 'text', 'spoiler']) &&
        isId(b.id) &&
        isStr(b.text, LIMITS.text) &&
        b.text.trim().length > 0 &&
        isBool(b.spoiler)
      )
    case 'delete':
      return isNonce(value.nonce) && onlyKeys(b, ['id']) && isId(b.id)
    case 'vouch':
      return isNonce(value.nonce) && onlyKeys(b, ['key']) && isKey(b.key)
    case 'bind':
      return isAuth(value.auth) && Object.keys(b).length === 0
    case 'revoke':
      return isNonce(value.nonce) && revokeBody(b)
  }
  return false
}

// ---- mapping rooms: episode ↔ chapter corrections, one Autobase per manhwa ---

/** Mirrors of src/data/mapping.ts (MAX_CHAPTER, MAX_CHAPTERS_PER_EPISODE). */
const MAP_LIMITS = { chapter: 20000, episode: 2000, perEpisode: 12 }
const MAX_MAP_NODE_BYTES = 4096
const isCount = (v, max) => Number.isInteger(v) && v >= 1 && v <= max

/** `{ s: season, f: 'end', b: last chapter }` or `{ s, f: 'ep', n: episode, a: first, b: last }`. */
function mapBody(b) {
  if (!isObj(b) || typeof b.s !== 'string' || !WORK.test(b.s) || !isCount(b.b, MAP_LIMITS.chapter)) return false
  if (b.f === 'end') return onlyKeys(b, ['s', 'f', 'b'])
  if (b.f === 'ep') {
    return (
      onlyKeys(b, ['s', 'f', 'n', 'a', 'b']) &&
      isCount(b.n, MAP_LIMITS.episode) &&
      isCount(b.a, MAP_LIMITS.chapter) &&
      b.a <= b.b &&
      b.b - b.a < MAP_LIMITS.perEpisode
    )
  }
  return false
}

function mapNode(value, room) {
  if (!envelope(value, ['map'], MAX_MAP_NODE_BYTES)) return false
  if (!WORK.test(room) || value.room !== 'map:' + room) return false
  return isNonce(value.nonce) && mapBody(value.body)
}

/** A device of the writer's own identity, revoked in its personal base, now refused here too. */
const revokeBody = (b) => onlyKeys(b, ['device']) && isKey(b.device)

/** Box key rotation: new public key + its seed sealed to each remaining device (and the root). */
const MAX_BOX_SEEDS = 24
function boxBody(b) {
  if (!onlyKeys(b, ['box', 'seeds']) || !isKey(b.box) || !isObj(b.seeds)) return false
  const keys = Object.keys(b.seeds)
  return (
    keys.length > 0 &&
    keys.length <= MAX_BOX_SEEDS &&
    keys.every((k) => (k === 'root' || isKey(k)) && isStr(b.seeds[k], 256) && HEX.test(b.seeds[k]))
  )
}

// ---- personal (home) base -------------------------------------------------

const JOURNAL_TYPES = ['ep', 'ch', 'comment']
function journalEntry(e) {
  if (!isObj(e) || !JOURNAL_TYPES.includes(e.type) || !WORK.test(String(e.work)) || !isTs(e.ts)) return false
  if (e.type === 'comment') return onlyKeys(e, ['type', 'work', 'ts'])
  return onlyKeys(e, ['type', 'work', 'unit', 'ts']) && Number.isInteger(e.unit) && e.unit >= 0 && e.unit < 100000
}

function homeNode(value) {
  if (!envelope(value, ['inception', 'profile', 'add-device', 'remove-device', 'label', 'block', 'follow', 'sub', 'xp', 'bind', 'box'])) {
    return false
  }
  if (value.room !== 'home') return false
  const b = value.body
  switch (value.t) {
    case 'inception':
      return onlyKeys(b, ['name', 'box', 'device']) && isStr(b.name, LIMITS.name) && isKey(b.box) && isStr(b.device, LIMITS.name)
    case 'profile':
      return (
        onlyKeys(b, ['name', 'bio', 'avatar', 'box', 'rot']) &&
        Object.keys(b).length > 0 &&
        optional(b.name, (v) => isStr(v, LIMITS.name)) &&
        optional(b.bio, (v) => isStr(v, LIMITS.bio, 0)) &&
        optional(b.avatar, (v) => isStr(v, LIMITS.avatar, 0)) &&
        optional(b.box, isKey) &&
        optional(b.rot, isKey)
      )
    case 'add-device':
      return onlyKeys(b, ['device', 'name']) && isKey(b.device) && isStr(b.name, LIMITS.name)
    case 'remove-device':
      return onlyKeys(b, ['device']) && isKey(b.device)
    case 'label':
      return (
        onlyKeys(b, ['target', 'val', 'neg']) &&
        isStr(b.target, 120) &&
        LABELS.includes(b.val) &&
        optional(b.neg, isBool)
      )
    case 'block':
    case 'follow':
    case 'sub':
      return onlyKeys(b, ['key', 'on']) && isKey(b.key) && isBool(b.on)
    case 'xp':
      return onlyKeys(b, ['entry', 'prev']) && journalEntry(b.entry) && (b.prev === null || isKey(b.prev))
    case 'bind':
      return isAuth(value.auth) && Object.keys(b).length === 0
    case 'box':
      return boxBody(b)
  }
  return false
}

// ---- direct messages -------------------------------------------------------

function dmNode(value) {
  if (!envelope(value, ['dm', 'seen', 'bind', 'revoke'], MAX_DM_NODE_BYTES)) return false
  if (value.room !== 'dm') return false
  const b = value.body
  switch (value.t) {
    case 'dm':
      return (
        isNonce(value.nonce) &&
        onlyKeys(b, ['id', 'to', 'r', 's']) &&
        isId(b.id) &&
        isKey(b.to) &&
        isStr(b.r, LIMITS.sealedHex) &&
        HEX.test(b.r) &&
        isStr(b.s, LIMITS.sealedHex) &&
        HEX.test(b.s)
      )
    case 'seen':
      return onlyKeys(b, ['upto']) && isTs(b.upto)
    case 'bind':
      return isAuth(value.auth) && Object.keys(b).length === 0
    case 'revoke':
      return revokeBody(b)
  }
  return false
}

/** Plaintext inside a sealed DM. */
function dmPlain(p) {
  return isObj(p) && onlyKeys(p, ['id', 'from', 'ts', 'text']) && isId(p.id) && isKey(p.from) && isTs(p.ts) && isStr(p.text, LIMITS.dmText)
}

// ---- hello (swarm connection handshake) -------------------------------------

function hello(m) {
  return (
    isObj(m) &&
    sizeOk(m, 4096) &&
    onlyKeys(m, ['v', 'id', 'home', 'box', 'proof', 'dm']) &&
    m.v === 1 &&
    isKey(m.id) &&
    isKey(m.home) &&
    isKey(m.box) &&
    typeof m.proof === 'string' &&
    m.proof.length <= 2048 &&
    HEX.test(m.proof) &&
    Array.isArray(m.dm) &&
    m.dm.length <= 64 &&
    m.dm.every(isKey)
  )
}

module.exports = {
  LIMITS,
  LABELS,
  MAX_NODE_BYTES,
  WORK,
  TARGET,
  roomNode,
  mapNode,
  mapBody,
  MAP_LIMITS,
  homeNode,
  dmNode,
  dmPlain,
  hello,
  journalEntry,
  isTs,
  isId
}
