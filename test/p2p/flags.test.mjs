// Flag rooms (community reports of comments): schema, reducer rules (signature, PoW, pacing,
// one active flag per author and comment, retraction, determinism), isolation from comment rooms,
// and propagation between two nodes.
// Run: npm run test:p2p
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'hypercore-crypto'
import IdentityKey from 'keet-identity-key'
import createTestnet from 'hyperdht/testnet.js'
import applyMod from '../../src/p2p/worklet/apply.js'
import powMod from '../../src/p2p/worklet/pow.js'
import authMod from '../../src/p2p/worklet/auth.js'
import schema from '../../src/p2p/worklet/schema.js'
import util from '../../src/p2p/worklet/util.js'
import worklet from '../../src/p2p/worklet/node.js'

const { createFlagApply, createRoomApply, createMapApply, FLAG_RATE, flagKey } = applyMod
const { makeAuth } = authMod
const { toHex } = util

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
  dump() {
    return JSON.stringify([...this.map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
  }
}

async function makeUser() {
  const ik = await IdentityKey.from({ mnemonic: IdentityKey.generateMnemonic() })
  const device = crypto.keyPair()
  const proof = await ik.bootstrap(device.publicKey)
  return { identity: toHex(ik.identityPublicKey), device, proof, home: crypto.randomBytes(32), writer: () => crypto.keyPair().publicKey }
}

let clock = 1_800_000_000_000
const tick = (ms) => (clock += ms)
const C1 = 'a'.repeat(32)
const C2 = 'b'.repeat(32)

async function flagNode(user, writerKey, body, { work = '42', bits = 16, withAuth = true, ts = tick(FLAG_RATE.minIntervalMs), nonce } = {}) {
  const value = { v: 1, t: 'flag', room: 'flag:' + work, ts, body }
  if (withAuth) value.auth = makeAuth({ device: user.device, proof: user.proof, writerKey, homeKey: user.home })
  value.nonce = nonce ?? (await powMod.solve(powMod.powPayload(value, toHex(writerKey)), bits))
  return { value, from: { key: writerKey }, optimistic: true }
}

const flag = (id, r = 'spam', on = true) => ({ id, r, on })

test('flag schema: strict bodies, reasons, room binding', () => {
  const ok = (body, work = '42', extra = {}) => schema.flagNode({ v: 1, t: 'flag', room: 'flag:' + work, ts: clock, nonce: 1, body, ...extra }, work)
  assert.ok(ok(flag(C1)))
  for (const r of ['spoiler', 'abuse', 'nsfw', 'spam', 'other']) assert.ok(ok(flag(C1, r)), r)
  assert.ok(ok(flag(C1, 'spam', false)))
  assert.ok(!ok(flag(C1, 'hide')), 'unknown reason')
  assert.ok(!ok(flag('xyz')), 'not a comment id')
  assert.ok(!ok({ ...flag(C1), note: 'hello' }), 'extra key')
  assert.ok(!ok({ id: C1, r: 'spam' }), 'on required')
  assert.ok(!schema.flagNode({ v: 1, t: 'flag', room: 'flag:43', ts: clock, nonce: 1, body: flag(C1) }, '42'), 'other room')
  assert.ok(!schema.flagNode({ v: 1, t: 'flag', room: 'flag:42', ts: clock, body: flag(C1) }, '42'), 'nonce required')
  assert.ok(!schema.flagNode({ v: 1, t: 'comment', room: 'flag:42', ts: clock, nonce: 1, body: flag(C1) }, '42'), 'other type')
  // The comment room does not know flag nodes (older peers never see them either).
  assert.ok(!schema.roomNode({ v: 1, t: 'flag', room: 'work:42', ts: clock, nonce: 1, body: flag(C1) }, '42'))
})

test('flag room: one active flag per author, newest wins, retraction, PoW, pacing', async () => {
  const apply = createFlagApply('42')
  const view = new FakeView()
  const alice = await makeUser()
  const w = alice.writer()

  const n1 = await flagNode(alice, w, flag(C1, 'spam'))
  await apply([n1], view, null)
  assert.deepEqual((await view.get(flagKey(C1, alice.identity))).value, { r: 'spam', ts: n1.value.ts })
  assert.equal((await view.get('w/' + toHex(w))).value.id, alice.identity)

  // A newer flag on the same comment replaces the reason.
  const n2 = await flagNode(alice, w, flag(C1, 'abuse'), { withAuth: false })
  await apply([n2], view, null)
  assert.equal((await view.get(flagKey(C1, alice.identity))).value.r, 'abuse')

  // Another comment is a separate flag.
  await apply([await flagNode(alice, w, flag(C2, 'spoiler'), { withAuth: false })], view, null)
  assert.equal((await view.get(flagKey(C2, alice.identity))).value.r, 'spoiler')

  // Too fast, backdated, wrong PoW, unbound writer: ignored.
  const fast = await flagNode(alice, w, flag(C1, 'nsfw'), { withAuth: false, ts: tick(200) })
  const back = await flagNode(alice, w, flag(C1, 'nsfw'), { withAuth: false, ts: clock - 60_000 })
  const badPow = await flagNode(alice, w, flag(C1, 'nsfw'), { withAuth: false, bits: 0, nonce: 0 })
  const stranger = await makeUser()
  const unbound = await flagNode(stranger, stranger.writer(), flag(C1), { withAuth: false })
  await apply([fast, back, badPow, unbound], view, null)
  assert.equal((await view.get(flagKey(C1, alice.identity))).value.r, 'abuse')
  assert.equal(await view.get(flagKey(C1, stranger.identity)), null)

  // Retraction removes it; retracting again is a no-op.
  await apply([await flagNode(alice, w, flag(C1, 'abuse', false), { withAuth: false })], view, null)
  assert.equal(await view.get(flagKey(C1, alice.identity)), null)
  const before = (await view.get('a/' + alice.identity)).value.n
  await apply([await flagNode(alice, w, flag(C1, 'abuse', false), { withAuth: false })], view, null)
  assert.equal((await view.get('a/' + alice.identity)).value.n, before)

  // Flag nodes are refused by comment and mapping rooms, and vice versa.
  const v2 = new FakeView()
  const bob = await makeUser()
  const bobFlag = await flagNode(bob, bob.writer(), flag(C1))
  await createRoomApply('42')([bobFlag], v2, null)
  await createMapApply('42')([bobFlag], v2, null)
  assert.equal(v2.map.size, 0)
})

test('flag room: hourly cap and determinism', async () => {
  const alice = await makeUser()
  const w = alice.writer()
  const nodes = []
  for (let i = 0; i < FLAG_RATE.perHour + 2; i++) {
    const id = i.toString(16).padStart(32, '0')
    nodes.push(await flagNode(alice, w, flag(id), { withAuth: i === 0, bits: i < 5 ? 16 : 12 }))
  }
  const a = new FakeView()
  const b = new FakeView()
  await createFlagApply('42')(nodes, a, null)
  await createFlagApply('42')(nodes, b, null)
  assert.equal(a.dump(), b.dump())
  assert.equal((await a.get('a/' + alice.identity)).value.n, FLAG_RATE.perHour)
})

test('flag room: reports propagate between nodes', { timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huwa-flag-'))
  const testnet = await createTestnet(3)
  const nodes = []
  const mk = async (name) => {
    const n = new worklet.HuwaNode({ storage: path.join(tmp, name), bootstrap: testnet.bootstrap, deviceName: name })
    await n.ready()
    nodes.push(n)
    return n
  }
  t.after(async () => {
    for (const n of nodes) await n.close().catch(() => {})
    await testnet.destroy()
  })
  const alice = await mk('alice')
  const bob = await mk('bob')
  const { profile: pa } = await alice.createIdentity('Alice')
  const { profile: pb } = await bob.createIdentity('Bob')

  const seen = []
  const stop = bob.watch('flags', '42', (all) => seen.push(all))
  await alice.flagComment('42', C1, 'spam')
  await assert.rejects(alice.flagComment('42', C1, 'hate'), /invalide/)
  await assert.rejects(alice.flagComment('42', 'nope', 'spam'), /invalide/)
  // Same reason again: nothing to publish.
  await alice.flagComment('42', C1, 'spam')

  const deadline = Date.now() + 30000
  while (Date.now() < deadline && !(seen.at(-1) || []).some((f) => f.author === pa.key)) await new Promise((r) => setTimeout(r, 200))
  const got = (seen.at(-1) || []).find((f) => f.author === pa.key)
  assert.deepEqual(got && { comment: got.comment, reason: got.reason }, { comment: C1, reason: 'spam' })

  // Bob flags too; Alice sees both. Then Bob retracts.
  await bob.flagComment('42', C1, 'abuse')
  let both = []
  const until = Date.now() + 30000
  while (Date.now() < until && both.length < 2) {
    both = (await alice.listFlags('42')).filter((f) => f.comment === C1)
    if (both.length < 2) await new Promise((r) => setTimeout(r, 200))
  }
  assert.deepEqual(both.map((f) => f.author).sort(), [pa.key, pb.key].sort())
  await new Promise((r) => setTimeout(r, FLAG_RATE.minIntervalMs + 50))
  await bob.flagComment('42', C1, null)
  assert.ok(!(await bob.listFlags('42')).some((f) => f.author === pb.key))
  stop()

  // Unsubscribed before the room finished opening: the room must not stay retained.
  alice.watch('flags', '77', () => {})()
  await alice._flagRoom('77')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(alice.flagRooms.get('77')?.refs, 0)
})
