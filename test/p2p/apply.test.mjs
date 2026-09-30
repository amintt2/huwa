// Unit tests of the deterministic Autobase reducers and of the proof of work.
// Run: npm run test:p2p
import test from 'node:test'
import assert from 'node:assert/strict'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import IdentityKey from 'keet-identity-key'
import applyMod from '../../src/p2p/worklet/apply.js'
import powMod from '../../src/p2p/worklet/pow.js'
import authMod from '../../src/p2p/worklet/auth.js'
import sealMod from '../../src/p2p/worklet/seal.js'
import util from '../../src/p2p/worklet/util.js'

const { createRoomApply, createHomeApply, createDmApply, commentId, RATE } = applyMod
const { makeAuth } = authMod
const { toHex } = util

// ---- helpers ---------------------------------------------------------------

/** Minimal in-memory Hyperbee stand-in (get/put/del/createReadStream). */
class FakeView {
  constructor() {
    this.map = new Map()
  }
  async get(key) {
    return this.map.has(key) ? { key, value: structuredClone(this.map.get(key)) } : null
  }
  async put(key, value) {
    this.map.set(key, structuredClone(value))
  }
  async del(key) {
    this.map.delete(key)
  }
  async *createReadStream({ gt, lt }) {
    for (const key of [...this.map.keys()].sort()) if (key > gt && key < lt) yield { key, value: this.map.get(key) }
  }
  dump() {
    return JSON.stringify([...this.map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
  }
}

class FakeHost {
  constructor() {
    this.acked = []
    this.added = []
    this.removed = []
  }
  async ackWriter(k) {
    this.acked.push(toHex(k))
  }
  async addWriter(k, opts) {
    this.added.push([toHex(k), opts.indexer])
  }
  async removeWriter(k) {
    this.removed.push(toHex(k))
  }
}

async function makeUser() {
  const ik = await IdentityKey.from({ mnemonic: IdentityKey.generateMnemonic() })
  const device = crypto.keyPair()
  const proof = await ik.bootstrap(device.publicKey)
  const identity = toHex(ik.identityPublicKey)
  const home = crypto.randomBytes(32)
  const writer = () => crypto.keyPair().publicKey
  return { ik, identity, device, proof, home, writer }
}

let clock = 1_800_000_000_000
const tick = (ms) => (clock += ms)

/** Build a signed, PoW-solved node exactly like the worklet does. */
async function node(user, writerKey, t, room, body, { bits, withAuth = true, ts = tick(RATE.minIntervalMs), nonce } = {}) {
  const value = { v: 1, t, room, ts, body }
  if (withAuth) value.auth = makeAuth({ device: user.device, proof: user.proof, writerKey, homeKey: user.home })
  if (bits !== undefined) value.nonce = nonce ?? (await powMod.solve(powMod.powPayload(value, toHex(writerKey), user.identity), bits))
  return { value, from: { key: writerKey }, optimistic: true }
}

function commentBody(user, ts, text = 'hello', extra = {}) {
  const target = 'ep:77-e1'
  return { id: commentId(user.identity, ts, target, text), target, text, spoiler: false, name: 'Nom', ...extra }
}

async function comment(user, writerKey, opts = {}) {
  const ts = tick(opts.gap ?? RATE.minIntervalMs)
  const body = commentBody(user, ts, opts.text, opts.extra)
  return node(user, writerKey, 'comment', 'work:77', body, { bits: opts.bits ?? 16, ts, withAuth: opts.withAuth ?? true, nonce: opts.nonce })
}

// ---- proof of work ---------------------------------------------------------

test('pow: solve/check, binding to writer, difficulty table', async () => {
  const value = { t: 'comment', room: 'work:1', ts: 1_800_000_000_000, body: { a: 1 } }
  const w1 = toHex(crypto.randomBytes(32))
  const w2 = toHex(crypto.randomBytes(32))
  const payload = powMod.powPayload(value, w1)
  const t0 = Date.now()
  const nonce = await powMod.solve(payload, 16)
  console.log('pow 16 bits solved in', Date.now() - t0, 'ms')
  assert.ok(powMod.check(payload, nonce, 16))
  // With 16 bits a random nonce passes with probability 2^-16; a changed payload must be re-solved.
  let replays = 0
  for (let i = 0; i < 20; i++) if (powMod.check(powMod.powPayload({ ...value, ts: value.ts + i + 1 }, w1), nonce, 16)) replays++
  if (powMod.check(powMod.powPayload(value, w2), nonce, 16)) replays++ // other writer
  assert.ok(replays <= 1)
  assert.ok(!powMod.check(payload, -1, 1))
  assert.ok(!powMod.check(payload, 2 ** 32, 1))
  assert.equal(powMod.leadingZeroBits(b4a.from([0, 0, 0x10])), 19)
  assert.equal(powMod.leadingZeroBits(b4a.from([0x80])), 0)
  assert.equal(powMod.difficultyFor(null), 16)
  assert.equal(powMod.difficultyFor({ n: 2, vouched: false }), 16)
  assert.equal(powMod.difficultyFor({ n: 5, vouched: false }), 12)
  assert.equal(powMod.difficultyFor({ n: 0, vouched: true }), 14)
  assert.equal(powMod.difficultyFor({ n: 60, vouched: true }), 8)
})

// ---- comment rooms ---------------------------------------------------------

test('room: accepts a valid comment, binds and promotes the writer', async () => {
  const apply = createRoomApply('77')
  const view = new FakeView()
  const host = new FakeHost()
  const alice = await makeUser()
  const w = alice.writer()
  const n = await comment(alice, w)
  await apply([n], view, host)
  const c = (await view.get('c/' + n.value.body.id)).value
  assert.equal(c.author, alice.identity)
  assert.equal(c.authorName, 'Nom')
  assert.deepEqual((await view.get('w/' + toHex(w))).value.id, alice.identity)
  assert.deepEqual(host.acked, [toHex(w)])
  assert.deepEqual(host.added, [[toHex(w), false]])
  // Second node from the same (now bound) writer does not need auth.
  const n2 = await comment(alice, w, { withAuth: false, bits: 16, text: 'deux' })
  await apply([n2], view, host)
  assert.ok(await view.get('c/' + n2.value.body.id))
})

test('room: rejects bad PoW, forged id, duplicates, unknown writer, foreign auth, schema', async () => {
  const apply = createRoomApply('77')
  const view = new FakeView()
  const alice = await makeUser()
  const w = alice.writer()

  const weak = await comment(alice, w, { bits: 4 })
  // Find a nonce that satisfies 4 bits but (almost surely) not 18.
  let nonce = 0
  const wp = powMod.powPayload(weak.value, toHex(w), alice.identity)
  while (!powMod.check(wp, nonce, 4) || powMod.check(wp, nonce, 16)) nonce++
  weak.value.nonce = nonce
  await apply([weak], view, null)
  assert.equal(view.map.size, 0, 'PoW too weak for an unknown key')

  const forged = await comment(alice, w)
  forged.value.body.id = 'f'.repeat(32)
  await apply([forged], view, null)
  assert.equal(view.map.size, 0, 'id must be the content hash')

  const noAuth = await comment(alice, w, { withAuth: false })
  await apply([noAuth], view, null)
  assert.equal(view.map.size, 0, 'unbound writer without auth')

  const other = alice.writer()
  const stolen = await comment(alice, w)
  stolen.from = { key: other } // auth attests `w`, not `other`
  await apply([stolen], view, null)
  assert.equal(view.map.size, 0, 'auth bound to another writer')

  const wrongWork = await comment(alice, w)
  wrongWork.value.room = 'work:78'
  await apply([wrongWork], view, null)
  assert.equal(view.map.size, 0, 'room mismatch')

  const tooLong = await comment(alice, w, { text: 'x'.repeat(2001) })
  await apply([tooLong], view, null)
  assert.equal(view.map.size, 0, 'text too long')

  const extraField = await comment(alice, w)
  extraField.value.body.evil = 1
  await apply([extraField], view, null)
  assert.equal(view.map.size, 0, 'unknown field')

  const ok = await comment(alice, w)
  await apply([ok, ok], view, null)
  const comments = [...view.map.keys()].filter((k) => k.startsWith('c/'))
  assert.equal(comments.length, 1, 'duplicate applied once')
})

test('room: deterministic rate limit (15 s interval, 20 per hour) and reply needs a parent', async () => {
  const apply = createRoomApply('77')
  const view = new FakeView()
  const alice = await makeUser()
  const w = alice.writer()
  const count = () => [...view.map.keys()].filter((k) => k.startsWith('c/')).length

  await apply([await comment(alice, w)], view, null)
  await apply([await comment(alice, w, { gap: 5_000, bits: 16 })], view, null)
  assert.equal(count(), 1, 'second comment 5 s later is refused')

  const orphan = await comment(alice, w, { bits: 16, extra: { parentId: 'a'.repeat(32) } })
  await apply([orphan], view, null)
  assert.equal(count(), 1, 'reply to an unknown parent is refused')

  for (let i = 0; i < 25; i++) await apply([await comment(alice, w, { gap: 16_000, bits: 16, text: 'm' + i })], view, null)
  assert.equal(count(), RATE.perHour, 'hourly cap')
  tick(RATE.hourMs)
  await apply([await comment(alice, w, { bits: 12, text: 'later' })], view, null)
  assert.equal(count(), RATE.perHour + 1, 'window slides')
})

test('room: likes toggle once per identity; vouch lowers difficulty', async () => {
  const apply = createRoomApply('77')
  const view = new FakeView()
  const alice = await makeUser()
  const bob = await makeUser()
  const wa = alice.writer()
  const wb = bob.writer()
  const c1 = await comment(alice, wa)
  await apply([c1], view, null)
  const id = c1.value.body.id
  const like = (on, withAuth) => node(bob, wb, 'like', 'work:77', { id, on }, { bits: powMod.DIFFICULTY.like, withAuth })
  await apply([await like(true, true), await like(true, false)], view, null)
  assert.equal((await view.get('c/' + id)).value.likes, 1)
  await apply([await like(false, false)], view, null)
  assert.equal((await view.get('c/' + id)).value.likes, 0)

  // Alice becomes established (5 comments) and vouches for Bob.
  for (let i = 0; i < 4; i++) await apply([await comment(alice, wa, { withAuth: false, bits: 16, text: 'e' + i })], view, null)
  assert.equal((await view.get('a/' + alice.identity)).value.n, 5)
  const vouch = await node(alice, wa, 'vouch', 'work:77', { key: bob.identity }, { bits: powMod.DIFFICULTY.established, withAuth: false })
  await apply([vouch], view, null)
  assert.equal((await view.get('a/' + bob.identity)).value.vouched, true)
  const bobComment = await comment(bob, wb, { withAuth: false, bits: powMod.DIFFICULTY.vouched })
  await apply([bobComment], view, null)
  assert.ok(await view.get('c/' + bobComment.value.body.id), 'vouched key posts with the lower difficulty')
})

test('room: only the author can edit or delete; deleted comments stay deleted', async () => {
  const apply = createRoomApply('77')
  const view = new FakeView()
  const alice = await makeUser()
  const bob = await makeUser()
  const wa = alice.writer()
  const wb = bob.writer()
  const c1 = await comment(alice, wa, { text: 'avant' })
  await apply([c1, await comment(bob, wb)], view, null)
  const id = c1.value.body.id
  const act = (user, w, t, body, withAuth = false) => node(user, w, t, 'work:77', body, { bits: powMod.DIFFICULTY.like, withAuth })

  // Bob cannot touch Alice's comment.
  await apply([await act(bob, wb, 'edit', { id, text: 'pirate', spoiler: false }), await act(bob, wb, 'delete', { id })], view, null)
  assert.equal((await view.get('c/' + id)).value.text, 'avant')
  assert.ok(!(await view.get('c/' + id)).value.deleted)

  // Alice edits, then deletes; an edit after deletion is refused.
  await apply([await act(alice, wa, 'edit', { id, text: 'après', spoiler: true })], view, null)
  let c = (await view.get('c/' + id)).value
  assert.equal(c.text, 'après')
  assert.equal(c.spoiler, true)
  assert.ok(c.editedAt > c.createdAt)
  await apply([await act(alice, wa, 'delete', { id })], view, null)
  c = (await view.get('c/' + id)).value
  assert.equal(c.deleted, true)
  assert.equal(c.text, '')
  await apply([await act(alice, wa, 'edit', { id, text: 'retour', spoiler: false })], view, null)
  assert.equal((await view.get('c/' + id)).value.text, '')

  // Schema: empty edit text and unknown fields are rejected before apply.
  const bad = await act(alice, wa, 'edit', { id, text: '   ', spoiler: false })
  await apply([bad], view, null)
  assert.equal((await view.get('c/' + id)).value.deleted, true)
})

test('room: same linearized nodes give byte-identical views (determinism)', async () => {
  const alice = await makeUser()
  const bob = await makeUser()
  const wa = alice.writer()
  const wb = bob.writer()
  const nodes = []
  nodes.push(await comment(alice, wa))
  nodes.push(await comment(bob, wb))
  nodes.push(await node(bob, wb, 'like', 'work:77', { id: nodes[0].value.body.id, on: true }, { bits: 8, withAuth: false }))
  nodes.push(await comment(alice, wa, { gap: 1000, bits: 16, withAuth: false, text: 'fast' })) // rate limited
  nodes.push({ value: null, from: { key: wa } }) // ack node
  nodes.push({ value: { garbage: true }, from: { key: wb } })
  const v1 = new FakeView()
  const v2 = new FakeView()
  await createRoomApply('77')(nodes, v1, new FakeHost())
  // Same nodes, delivered in two batches: the reducer must not depend on batching.
  await createRoomApply('77')(nodes.slice(0, 2), v2, null)
  await createRoomApply('77')(nodes.slice(2), v2, null)
  assert.equal(v1.dump(), v2.dump())
})

// ---- personal base -----------------------------------------------------------

test('home: only devices of the owner, revocation, hash-chained journal', async () => {
  const alice = await makeUser()
  const mallory = await makeUser()
  const apply = createHomeApply(alice.identity)
  const view = new FakeView()
  const host = new FakeHost()
  const w1 = alice.writer()
  const inc = await node(alice, w1, 'inception', 'home', { name: 'Alice', box: toHex(crypto.randomBytes(32)), device: 'iPhone' })
  await apply([inc], view, host)
  assert.equal((await view.get('profile')).value.name, 'Alice')
  assert.deepEqual(host.added, [[toHex(w1), true]], 'devices are indexers of the personal base')

  const evil = await node(mallory, mallory.writer(), 'profile', 'home', { name: 'Pwned' })
  await apply([evil], view, host)
  assert.equal((await view.get('profile')).value.name, 'Alice', 'foreign identity ignored')

  // A second device attested by the first one joins with `bind`.
  const dev2 = crypto.keyPair()
  const proof2 = IdentityKey.attestDevice(dev2.publicKey, alice.device, alice.proof)
  const alice2 = { ...alice, device: dev2, proof: proof2 }
  const w2 = alice.writer()
  await apply([await node(alice2, w2, 'bind', 'home', {})], view, host)
  assert.ok(await view.get('dev/' + toHex(dev2.publicKey)))

  await apply([await node(alice, w1, 'remove-device', 'home', { device: toHex(dev2.publicKey) }, { withAuth: false })], view, host)
  assert.deepEqual(host.removed, [toHex(w2)])
  await apply([await node(alice2, w2, 'profile', 'home', { bio: 'après révocation' }, { withAuth: false })], view, host)
  assert.equal((await view.get('profile')).value.bio, undefined, 'revoked device ignored')

  // Journal: prev must match the head; implausible entries stay in the chain with ok=false.
  const xp = (entry, prev) => node(alice, w1, 'xp', 'home', { entry, prev }, { withAuth: false })
  const t = tick(0)
  await apply([await xp({ type: 'ep', work: '77', unit: 1, ts: t }, null)], view, host)
  const head = (await view.get('xphead')).value
  await apply([await xp({ type: 'ep', work: '77', unit: 2, ts: t + 60_000 }, null)], view, host)
  assert.equal((await view.get('xphead')).value.seq, 0, 'wrong prev refused')
  await apply([await xp({ type: 'ep', work: '77', unit: 2, ts: t + 60_000 }, head.hash)], view, host)
  const second = (await view.get('xp/' + util.pad(1, 10))).value
  assert.equal(second.ok, false, 'episodes 1 min apart earn no XP')
  await apply([await xp({ type: 'ep', work: '77', unit: 3, ts: t + 30 * 60_000 }, second.hash)], view, host)
  assert.equal((await view.get('xp/' + util.pad(2, 10))).value.ok, true)
})

// ---- direct messages ---------------------------------------------------------

test('dm: only the pair, sealed boxes, per-author monotonic ts, read receipts', async () => {
  const alice = await makeUser()
  const bob = await makeUser()
  const eve = await makeUser()
  const pair = [alice.identity, bob.identity].sort()
  const apply = createDmApply(pair)
  const view = new FakeView()
  const bobBox = sealMod.boxKeyPair(crypto.randomBytes(32))
  const aliceBox = sealMod.boxKeyPair(crypto.randomBytes(32))
  const wa = alice.writer()
  const msg = async (user, w, to, text, opts = {}) => {
    const id = toHex(crypto.randomBytes(16))
    const ts = opts.ts ?? tick(1000)
    const plain = JSON.stringify({ id, from: user.identity, ts, text })
    return node(user, w, 'dm', 'dm', { id, to, r: toHex(sealMod.seal(plain, bobBox.publicKey)), s: toHex(sealMod.seal(plain, aliceBox.publicKey)) }, { bits: powMod.DIFFICULTY.dm, ts, withAuth: opts.withAuth ?? true })
  }
  const m1 = await msg(alice, wa, bob.identity, 'salut')
  await apply([m1], view, null)
  const stored = [...view.map.entries()].find(([k]) => k.startsWith('m/'))[1]
  const opened = JSON.parse(b4a.toString(sealMod.open(util.fromHex(stored.r), bobBox)))
  assert.equal(opened.text, 'salut')
  assert.equal(sealMod.open(util.fromHex(stored.r), aliceBox), null, 'only the recipient opens r')

  await apply([await msg(eve, eve.writer(), bob.identity, 'spam')], view, null)
  await apply([await msg(alice, wa, eve.identity, 'wrong to', { withAuth: false })], view, null)
  await apply([await msg(alice, wa, bob.identity, 'old', { withAuth: false, ts: m1.value.ts })], view, null)
  assert.equal([...view.map.keys()].filter((k) => k.startsWith('m/')).length, 1)

  const wb = bob.writer()
  await apply([await node(bob, wb, 'seen', 'dm', { upto: m1.value.ts })], view, null)
  assert.equal((await view.get('s/' + bob.identity)).value.seen, m1.value.ts)
})
