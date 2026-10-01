// Episode ↔ chapter correction rooms: reducer rules (signature, PoW, schema, pacing, one active
// proposal per author and field, determinism) and propagation between two nodes.
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

const { createMapApply, createRoomApply, MAP_RATE } = applyMod
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

async function mapNode(user, writerKey, body, { room = 'm42', bits = 16, withAuth = true, ts = tick(MAP_RATE.minIntervalMs), nonce } = {}) {
  const value = { v: 1, t: 'map', room: 'map:' + room, ts, body }
  if (withAuth) value.auth = makeAuth({ device: user.device, proof: user.proof, writerKey, homeKey: user.home })
  value.nonce = nonce ?? (await powMod.solve(powMod.powPayload(value, toHex(writerKey)), bits))
  return { value, from: { key: writerKey }, optimistic: true }
}

const end = (to, s = 'al2') => ({ s, f: 'end', b: to })
const ep = (n, a, b, s = 'al2') => ({ s, f: 'ep', n, a, b })

test('map schema: strict bodies, room binding, limits', () => {
  const ok = (body, room = 'm42') => schema.mapNode({ v: 1, t: 'map', room: 'map:' + room, ts: clock, nonce: 1, body }, room)
  assert.ok(ok(end(88)))
  assert.ok(ok(ep(3, 60, 62)))
  assert.ok(!ok(end(0)))
  assert.ok(!ok(end(20001)))
  assert.ok(!ok(end(1.5)))
  assert.ok(!ok({ ...end(88), x: 1 }))
  assert.ok(!ok({ s: 'al 2', f: 'end', b: 3 }))
  assert.ok(!ok(ep(3, 62, 60)), 'from after to')
  assert.ok(!ok(ep(3, 60, 72)), 'more than 12 chapters')
  assert.ok(!ok(ep(0, 1, 2)))
  assert.ok(!ok({ s: 'al2', f: 'src', b: 3 }))
  assert.ok(!schema.mapNode({ v: 1, t: 'map', room: 'map:m41', ts: clock, nonce: 1, body: end(88) }, 'm42'), 'other room')
  assert.ok(!schema.mapNode({ v: 1, t: 'map', room: 'map:m42', ts: clock, body: end(88) }, 'm42'), 'nonce required')
  assert.ok(!schema.mapNode({ v: 1, t: 'comment', room: 'map:m42', ts: clock, nonce: 1, body: end(88) }, 'm42'))
})

test('map room: signed proposals, newest replaces, PoW, pacing, unknown writers', async () => {
  const apply = createMapApply('m42')
  const view = new FakeView()
  const alice = await makeUser()
  const w = alice.writer()

  const n1 = await mapNode(alice, w, end(88))
  await apply([n1], view, null)
  assert.deepEqual((await view.get('p/al2/end/' + alice.identity)).value, { to: 88, ts: n1.value.ts })
  assert.equal((await view.get('w/' + toHex(w))).value.id, alice.identity)

  // Newer value from the same author replaces it (bound writer: no auth needed).
  const n2 = await mapNode(alice, w, end(90), { withAuth: false })
  await apply([n2], view, null)
  assert.equal((await view.get('p/al2/end/' + alice.identity)).value.to, 90)

  // Episode field is separate.
  const n3 = await mapNode(alice, w, ep(1, 58, 60), { withAuth: false })
  await apply([n3], view, null)
  assert.deepEqual((await view.get('p/al2/ep0001/' + alice.identity)).value, { from: 58, to: 60, ts: n3.value.ts })

  // Too fast, backdated, wrong PoW, unknown writer: ignored.
  const fast = await mapNode(alice, w, end(91), { withAuth: false, ts: tick(500) })
  const back = await mapNode(alice, w, end(92), { withAuth: false, ts: clock - 60_000 })
  const badPow = await mapNode(alice, w, end(93), { withAuth: false, bits: 0, nonce: 0 })
  const stranger = await makeUser()
  const unbound = await mapNode(stranger, stranger.writer(), end(94), { withAuth: false })
  await apply([fast, back, badPow, unbound], view, null)
  assert.equal((await view.get('p/al2/end/' + alice.identity)).value.to, 90)
  assert.equal(await view.get('p/al2/end/' + stranger.identity), null)

  // Another identity has its own active value.
  const bob = await makeUser()
  await apply([await mapNode(bob, bob.writer(), end(88))], view, null)
  assert.equal((await view.get('p/al2/end/' + bob.identity)).value.to, 88)

  // A comment node is not a mapping node, and a mapping node is refused by a comment room.
  const room = createRoomApply('m42')
  const v2 = new FakeView()
  await room([await mapNode(bob, bob.writer(), end(70))], v2, null)
  assert.equal(v2.map.size, 0)
})

test('map room: hourly cap and determinism', async () => {
  const alice = await makeUser()
  const w = alice.writer()
  const nodes = []
  for (let i = 0; i < MAP_RATE.perHour + 2; i++) nodes.push(await mapNode(alice, w, end(50 + i), { withAuth: i === 0, bits: i < 5 ? 16 : 12 }))
  const a = new FakeView()
  const b = new FakeView()
  await createMapApply('m42')(nodes, a, null)
  await createMapApply('m42')(nodes, b, null)
  assert.equal(a.dump(), b.dump())
  // Within one hour at most `perHour` proposals are accepted.
  assert.equal((await a.get('a/' + alice.identity)).value.n, MAP_RATE.perHour)
  assert.equal((await a.get('p/al2/end/' + alice.identity)).value.to, 50 + MAP_RATE.perHour - 1)
})

test('map room: proposals propagate between nodes', { timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huwa-map-'))
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
  const stop = bob.watch('mapping', 'm42', (all) => seen.push(all))
  await alice.proposeMapping({ room: 'm42', season: 'al2', field: 'end', to: 88 })
  await assert.rejects(alice.proposeMapping({ room: 'm42', season: 'al2', field: 'end', to: 89 }), /Patiente/)
  await assert.rejects(alice.proposeMapping({ room: 'm42', season: 'al2', field: 'ep', ep: 1, from: 5, to: 2 }), /invalide/)

  const deadline = Date.now() + 30000
  while (Date.now() < deadline && !(seen.at(-1) || []).some((p) => p.author === pa.key)) await new Promise((r) => setTimeout(r, 200))
  const got = (seen.at(-1) || []).find((p) => p.author === pa.key)
  assert.deepEqual(got && { season: got.season, field: got.field, to: got.to }, { season: 'al2', field: 'end', to: 88 })

  // Bob confirms; Alice sees both.
  await bob.proposeMapping({ room: 'm42', season: 'al2', field: 'end', to: 88 })
  let both = []
  const until = Date.now() + 30000
  while (Date.now() < until && both.length < 2) {
    both = (await alice.listMapping('m42')).filter((p) => p.field === 'end' && p.to === 88)
    if (both.length < 2) await new Promise((r) => setTimeout(r, 200))
  }
  assert.deepEqual(both.map((p) => p.author).sort(), [pa.key, pb.key].sort())
  stop()

  // Unsubscribed before the room finished opening: the room must not stay retained.
  for (const [kind, room, rooms] of [['mapping', 'm77', alice.mapRooms], ['comments', '7777', alice.rooms]]) {
    alice.watch(kind, room, () => {})()
    await (kind === 'mapping' ? alice._mapRoom(room) : alice._room(room))
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(rooms.get(room)?.refs, 0, kind + ': no reference left after an early unsubscribe')
  }
})
