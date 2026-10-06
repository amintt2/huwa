// Deterministic Autobase reducers (PLAN.md phases 2, 3, 5, 6).
// `apply` is the only "server": it may only read the node contents, their linearized order
// and the view. No clock, no network, no globals, no randomness.
//
// `view` is a Hyperbee (or anything with async get/put/del). `host` is the Autobase host
// (ackWriter/addWriter/removeWriter) and may be null in unit tests.
const { canon, hash, toHex, fromHex, pad } = require('./util')
const schema = require('./schema')
const pow = require('./pow')
const { verifyAuth } = require('./auth')

const RATE = {
  minIntervalMs: 15_000, // one comment every 15 s per identity
  perHour: 20,
  hourMs: 3_600_000
}

/** Corrections are cheap to read and rarely sent: a looser pace than comments. */
const MAP_RATE = {
  minIntervalMs: 3_000,
  perHour: 60,
  hourMs: 3_600_000
}

/** Reports: a few per minute at most, cheap to verify, rarely sent. */
const FLAG_RATE = {
  minIntervalMs: 3_000,
  perHour: 60,
  hourMs: 3_600_000
}

const XP_RULES = {
  minEpisodeGapMs: 20 * 60_000,
  maxPerDay: 30,
  dayMs: 86_400_000
}

const get = async (view, key) => {
  const node = await view.get(key)
  return node ? node.value : null
}

function commentId(author, ts, target, text) {
  return toHex(hash(canon({ a: author, ts, target, text }), 16))
}

/** Resolve the identity behind a writer, binding it on first sight. */
async function resolveWriter(view, node) {
  const w = toHex(node.from.key)
  const bound = await get(view, 'w/' + w)
  if (bound) return { w, who: bound, fresh: false }
  const a = node.value.auth ? verifyAuth(node.value.auth, node.from.key) : null
  if (!a) return null
  return { w, who: { id: a.identity, dev: a.device, home: a.home }, fresh: true }
}

async function accept(view, host, node, writer, { indexer = false } = {}) {
  if (!writer.fresh) return
  await view.put('w/' + writer.w, writer.who)
  await view.put('dw/' + writer.who.dev + '/' + writer.w, 1)
  if (host) {
    if (node.optimistic !== false && host.ackWriter) await host.ackWriter(node.from.key)
    if (host.addWriter) await host.addWriter(node.from.key, { indexer })
  }
}

// ---- device revocation in shared bases (rooms, DMs) --------------------------
// A personal base cannot be read from `apply`, so a revocation is republished in each shared base
// by a remaining device of the same identity (`revoke` node). From then on, every node of a writer
// bound to that device is refused. An identity can only revoke its own devices (`rv/<id>/<dev>`);
// the first revocation linearized wins, as in the personal base.

const isRevoked = async (view, writer) => !!(await get(view, 'rv/' + writer.who.id + '/' + writer.who.dev))

async function revokeStep(view, host, writer, device) {
  if (device === writer.who.dev) return false
  const key = 'rv/' + writer.who.id + '/' + device
  if (await get(view, key)) return false
  await view.put(key, 1)
  if (host && host.removeWriter) {
    for await (const e of view.createReadStream({ gt: 'dw/' + device + '/', lt: 'dw/' + device + '0' })) {
      const w = e.key.split('/')[2]
      const who = await get(view, 'w/' + w)
      if (!who || who.id !== writer.who.id) continue
      try {
        await host.removeWriter(fromHex(w))
      } catch {
        // Not removable (e.g. last indexer): its nodes are refused anyway.
      }
    }
  }
  return true
}

// ---- comment room: one Autobase per work -----------------------------------

/**
 * Per identity: one write every `minIntervalMs` and `perHour` per hour (comments: 15 s / 20).
 * Timestamps only have to grow per device (`dev`): the devices of one identity have their own,
 * possibly skewed, clocks.
 */
function rateOk(stats, ts, dev, rules = RATE) {
  if (!stats) return { ok: true, recent: [] }
  const devLast = dev === undefined ? stats.last : (stats.devs && stats.devs[dev]) || 0
  if (ts <= devLast) return { ok: false }
  if (stats.last && Math.abs(ts - stats.last) < rules.minIntervalMs) return { ok: false }
  const recent = stats.recent.filter((r) => Math.abs(ts - r) < rules.hourMs)
  if (recent.some((r) => Math.abs(ts - r) < rules.minIntervalMs)) return { ok: false }
  if (recent.length >= rules.perHour) return { ok: false }
  return { ok: true, recent }
}

async function roomStep(view, node, writer, work) {
  const v = node.value
  const b = v.body
  const author = writer.who.id
  const stats = await get(view, 'a/' + author)

  if (v.t === 'comment') {
    if (!pow.check(pow.powPayload(v, writer.w, author), v.nonce, pow.difficultyFor(stats))) return false
    if (b.id !== commentId(author, v.ts, b.target, b.text)) return false
    if (await get(view, 'c/' + b.id)) return false
    if (b.parentId && !(await get(view, 'c/' + b.parentId))) return false
    const rate = rateOk(stats, v.ts, writer.who.dev)
    if (!rate.ok) return false
    await view.put('c/' + b.id, {
      id: b.id,
      target: b.target,
      parentId: b.parentId,
      author,
      authorName: b.name,
      text: b.text,
      createdAt: v.ts,
      likes: 0,
      spoiler: b.spoiler,
      timestamp: b.timestamp,
      fromAnime: b.fromAnime
    })
    await view.put('a/' + author, {
      n: (stats ? stats.n : 0) + 1,
      last: v.ts,
      recent: rate.recent.concat(v.ts),
      vouched: !!(stats && stats.vouched),
      devs: { ...((stats && stats.devs) || {}), [writer.who.dev]: v.ts }
    })
    return true
  }

  if (v.t === 'like') {
    if (!pow.check(pow.powPayload(v, writer.w), v.nonce, pow.DIFFICULTY.like)) return false
    const comment = await get(view, 'c/' + b.id)
    if (!comment) return false
    const key = 'l/' + b.id + '/' + author
    const has = !!(await get(view, key))
    if (has === b.on) return false
    if (b.on) await view.put(key, 1)
    else await view.del(key)
    await view.put('c/' + b.id, { ...comment, likes: Math.max(0, comment.likes + (b.on ? 1 : -1)) })
    return true
  }

  // Edit / delete: only the comment's author, never on a deleted comment. A deleted comment keeps
  // its id (replies still point at it) but loses its text.
  if (v.t === 'edit' || v.t === 'delete') {
    if (!pow.check(pow.powPayload(v, writer.w), v.nonce, pow.DIFFICULTY.like)) return false
    const comment = await get(view, 'c/' + b.id)
    if (!comment || comment.deleted || comment.author !== author) return false
    if (v.ts <= comment.createdAt) return false
    if (v.t === 'delete') {
      await view.put('c/' + b.id, { ...comment, text: '', spoiler: false, deleted: true, editedAt: v.ts })
    } else {
      await view.put('c/' + b.id, { ...comment, text: b.text, spoiler: b.spoiler, editedAt: v.ts })
    }
    return true
  }

  if (v.t === 'vouch') {
    if (!stats || stats.n < 5) return false
    if (!pow.check(pow.powPayload(v, writer.w), v.nonce, pow.difficultyFor(stats))) return false
    if (b.key === author) return false
    const target = await get(view, 'a/' + b.key)
    if (target && target.vouched) return false
    await view.put('a/' + b.key, target ? { ...target, vouched: true } : { n: 0, last: 0, recent: [], vouched: true })
    return true
  }
  return false
}

function createRoomApply(work) {
  return async function apply(nodes, view, host) {
    for (const node of nodes) {
      if (node.value === null || !schema.roomNode(node.value, work)) continue
      const writer = await resolveWriter(view, node)
      if (!writer || (await isRevoked(view, writer))) continue
      if (node.value.t === 'revoke') {
        if (!pow.check(pow.powPayload(node.value, writer.w), node.value.nonce, pow.DIFFICULTY.like)) continue
        if (await revokeStep(view, host, writer, node.value.body.device)) await accept(view, host, node, writer)
        continue
      }
      if (await roomStep(view, node, writer, work)) await accept(view, host, node, writer)
    }
  }
}

// ---- mapping room: episode ↔ chapter corrections, one Autobase per manhwa ---
// Each identity has one active value per (season, field): `p/<season>/<field>/<author>`, the newest
// replaces the older one. The consensus itself is computed by every reader (src/social/consensus.ts),
// weighted by the author's rank: the room only keeps signed, paced, well-formed proposals.

const mapField = (b) => (b.f === 'end' ? 'end' : 'ep' + pad(b.n, 4))
const mapKey = (b, author) => 'p/' + b.s + '/' + mapField(b) + '/' + author

async function mapStep(view, node, writer) {
  const v = node.value
  const b = v.body
  const author = writer.who.id
  const stats = await get(view, 'a/' + author)
  if (!pow.check(pow.powPayload(v, writer.w), v.nonce, pow.difficultyFor(stats))) return false
  const rate = rateOk(stats, v.ts, writer.who.dev, MAP_RATE)
  if (!rate.ok) return false
  const key = mapKey(b, author)
  const prev = await get(view, key)
  if (prev && prev.ts >= v.ts) return false
  await view.put(key, b.f === 'end' ? { to: b.b, ts: v.ts } : { from: b.a, to: b.b, ts: v.ts })
  await view.put('a/' + author, { n: (stats ? stats.n : 0) + 1, last: Math.max((stats && stats.last) || 0, v.ts), recent: rate.recent.concat(v.ts), vouched: false, devs: { ...((stats && stats.devs) || {}), [writer.who.dev]: v.ts } })
  return true
}

function createMapApply(room) {
  return async function apply(nodes, view, host) {
    for (const node of nodes) {
      if (node.value === null || !schema.mapNode(node.value, room)) continue
      const writer = await resolveWriter(view, node)
      if (!writer) continue
      if (await mapStep(view, node, writer)) await accept(view, host, node, writer)
    }
  }
}

// ---- flag room: community reports, one Autobase per work ---------------------
// One active flag per (comment, author): `f/<comment>/<author>` = { r, ts }; a newer flag replaces
// it, `on: false` retracts it. The room cannot see the comment room, so flags on unknown ids are
// kept (they only count once a reader matches them with a comment). The outcome is computed by
// every reader (src/social/community.ts), weighted by the author's rank.

const flagKey = (id, author) => 'f/' + id + '/' + author

async function flagStep(view, node, writer) {
  const v = node.value
  const b = v.body
  const author = writer.who.id
  const stats = await get(view, 'a/' + author)
  if (!pow.check(pow.powPayload(v, writer.w), v.nonce, pow.difficultyFor(stats))) return false
  const rate = rateOk(stats, v.ts, writer.who.dev, FLAG_RATE)
  if (!rate.ok) return false
  const key = flagKey(b.id, author)
  const prev = await get(view, key)
  if (prev && prev.ts >= v.ts) return false
  if (b.on) await view.put(key, { r: b.r, ts: v.ts })
  else if (prev) await view.del(key)
  else return false
  await view.put('a/' + author, { n: (stats ? stats.n : 0) + 1, last: Math.max((stats && stats.last) || 0, v.ts), recent: rate.recent.concat(v.ts), vouched: false, devs: { ...((stats && stats.devs) || {}), [writer.who.dev]: v.ts } })
  return true
}

function createFlagApply(work) {
  return async function apply(nodes, view, host) {
    for (const node of nodes) {
      if (node.value === null || !schema.flagNode(node.value, work)) continue
      const writer = await resolveWriter(view, node)
      if (!writer) continue
      if (await flagStep(view, node, writer)) await accept(view, host, node, writer)
    }
  }
}

// ---- personal base: identity journal, profile, moderation, XP --------------

async function logEvent(view, t, body, ts, dev) {
  const meta = (await get(view, 'meta')) || { events: 0 }
  await view.put('ev/' + pad(meta.events, 10), { t, body, ts, dev })
  await view.put('meta', { ...meta, events: meta.events + 1 })
}

async function xpStep(view, entry, prev) {
  const head = await get(view, 'xphead')
  const expected = head ? head.hash : null
  if (prev !== expected) return false
  const seq = head ? head.seq + 1 : 0
  const h = toHex(hash(canon({ entry, prev })))
  // Plausibility caps (phase 6): the entry stays in the chain, it just earns no XP.
  let ok = true
  const day = Math.floor(entry.ts / XP_RULES.dayMs)
  const counter = (await get(view, 'xpday')) || { day, count: 0 }
  const count = counter.day === day ? counter.count : 0
  if (count >= XP_RULES.maxPerDay) ok = false
  if (entry.type === 'ep') {
    const last = await get(view, 'xplast/ep')
    if (last && entry.ts - last < XP_RULES.minEpisodeGapMs) ok = false
    await view.put('xplast/ep', entry.ts)
  }
  if (head && entry.ts < head.ts) ok = false
  await view.put('xpday', { day, count: count + 1 })
  await view.put('xp/' + pad(seq, 10), { entry, prev, hash: h, ok })
  await view.put('xphead', { seq, hash: h, ts: Math.max(entry.ts, head ? head.ts : 0) })
  return true
}

async function homeStep(view, host, node, writer) {
  const v = node.value
  const b = v.body
  const dev = writer.who.dev
  switch (v.t) {
    case 'inception': {
      if (await get(view, 'profile')) return false
      await view.put('profile', { name: b.name, box: b.box, createdAt: v.ts })
      await view.put('dev/' + dev, { name: b.device, addedAt: v.ts })
      await logEvent(view, 'inception', b, v.ts, dev)
      return true
    }
    case 'profile': {
      const profile = await get(view, 'profile')
      if (!profile) return false
      await view.put('profile', { ...profile, ...b })
      await logEvent(view, 'profile', b, v.ts, dev)
      return true
    }
    case 'add-device': {
      if (await get(view, 'rev/' + b.device)) return false
      await view.put('dev/' + b.device, { name: b.name, addedAt: v.ts })
      await logEvent(view, 'add-device', b, v.ts, dev)
      return true
    }
    case 'remove-device': {
      if (await get(view, 'rev/' + b.device)) return false
      const d = await get(view, 'dev/' + b.device)
      await view.put('rev/' + b.device, { ts: v.ts, by: dev })
      await view.put('dev/' + b.device, { ...(d || { name: '?', addedAt: v.ts }), revoked: true })
      if (host && host.removeWriter) {
        for await (const e of view.createReadStream({ gt: 'dw/' + b.device + '/', lt: 'dw/' + b.device + '0' })) {
          const w = e.key.split('/')[2]
          try {
            await host.removeWriter(fromHex(w))
          } catch {
            // Removing the last indexer is refused by Autobase; the device stays marked revoked.
          }
        }
      }
      await logEvent(view, 'remove-device', b, v.ts, dev)
      return true
    }
    case 'box': {
      // DM key rotation (after a revocation): the new seed is sealed to each remaining device.
      const profile = await get(view, 'profile')
      if (!profile) return false
      const meta = (await get(view, 'boxmeta')) || { n: 0 }
      await view.put('box/' + pad(meta.n, 10), { box: b.box, seeds: b.seeds, ts: v.ts, dev })
      await view.put('boxmeta', { n: meta.n + 1 })
      if (profile.box !== b.box) {
        await view.put('profile', { ...profile, box: b.box })
        await logEvent(view, 'box', { box: b.box }, v.ts, dev)
      }
      return true
    }
    case 'label':
      await view.put('lab/' + toHex(hash(canon({ t: b.target, v: b.val }), 16)), { target: b.target, val: b.val, neg: b.neg, ts: v.ts })
      return true
    case 'block':
    case 'follow':
    case 'sub': {
      const key = { block: 'blk/', follow: 'fol/', sub: 'sub/' }[v.t] + b.key
      if (b.on) await view.put(key, { ts: v.ts })
      else await view.del(key)
      return true
    }
    case 'xp':
      return xpStep(view, b.entry, b.prev)
    case 'bind': {
      // A device joining the base (pairing / restore): register it if it is new.
      if (!(await get(view, 'dev/' + dev))) {
        await view.put('dev/' + dev, { name: 'appareil', addedAt: v.ts })
        await logEvent(view, 'add-device', { device: dev, name: 'appareil' }, v.ts, dev)
      }
      return true
    }
  }
  return false
}

function createHomeApply(identity) {
  return async function apply(nodes, view, host) {
    for (const node of nodes) {
      if (node.value === null || !schema.homeNode(node.value)) continue
      const writer = await resolveWriter(view, node)
      if (!writer || writer.who.id !== identity) continue
      if (await get(view, 'rev/' + writer.who.dev)) continue
      if (await homeStep(view, host, node, writer)) await accept(view, host, node, writer, { indexer: true })
    }
  }
}

// ---- direct messages: one Autobase per pair of identities ------------------

async function dmStep(view, node, writer, pair) {
  const v = node.value
  const b = v.body
  const from = writer.who.id
  const other = pair[0] === from ? pair[1] : pair[0]
  const state = (await get(view, 's/' + from)) || { last: 0, seen: 0 }
  if (v.t === 'dm') {
    if (b.to !== other) return false
    // Increasing per device (each device of an identity has its own clock).
    const devs = state.devs || {}
    if (v.ts <= (devs[writer.who.dev] || 0)) return false
    if (!pow.check(pow.powPayload(v, writer.w), v.nonce, pow.DIFFICULTY.dm)) return false
    if (await get(view, 'mi/' + b.id)) return false
    await view.put('mi/' + b.id, 1)
    await view.put('m/' + pad(v.ts) + '/' + b.id, { id: b.id, from, to: b.to, ts: v.ts, r: b.r, s: b.s })
    await view.put('s/' + from, { ...state, last: Math.max(state.last, v.ts), devs: { ...devs, [writer.who.dev]: v.ts } })
    return true
  }
  if (v.t === 'seen') {
    if (b.upto <= state.seen) return false
    await view.put('s/' + from, { ...state, seen: b.upto })
    return true
  }
  return v.t === 'bind'
}

function createDmApply(pair) {
  return async function apply(nodes, view, host) {
    for (const node of nodes) {
      if (node.value === null || !schema.dmNode(node.value)) continue
      const writer = await resolveWriter(view, node)
      if (!writer || !pair.includes(writer.who.id) || (await isRevoked(view, writer))) continue
      if (node.value.t === 'revoke') {
        if (await revokeStep(view, host, writer, node.value.body.device)) await accept(view, host, node, writer)
        continue
      }
      if (await dmStep(view, node, writer, pair)) await accept(view, host, node, writer)
    }
  }
}

module.exports = {
  RATE,
  MAP_RATE,
  mapKey,
  createMapApply,
  FLAG_RATE,
  flagKey,
  createFlagApply,
  XP_RULES,
  commentId,
  rateOk,
  createRoomApply,
  createHomeApply,
  createDmApply
}
