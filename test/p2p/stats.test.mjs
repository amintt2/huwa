// Community playback stats: validator / reducer of the monthly rooms, agreement with the app-side
// rules (src/stats/community.ts), and an end-to-end contribution over a local testnet.
// Run: npm run test:p2p
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'hypercore-crypto'
import createTestnet from 'hyperdht/testnet.js'
import statsMod from '../../src/p2p/worklet/stats.js'
import powMod from '../../src/p2p/worklet/pow.js'
import util from '../../src/p2p/worklet/util.js'
import worklet from '../../src/p2p/worklet/node.js'
import * as community from '../../src/stats/community.ts'

const { createStatsApply, statsNode, statsBody, mergeInto, STATS_BITS, DAY_MS } = statsMod
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
}

class FakeHost {
  constructor() {
    this.acked = []
    this.added = []
  }
  async ackWriter(k) {
    this.acked.push(toHex(k))
  }
  async addWriter(k, opts) {
    this.added.push([toHex(k), opts.indexer])
  }
}

const MONTH = '2027-01'
const DAY = Date.UTC(2027, 0, 12)
const hist = (fill = 1) => new Array(community.BUCKET_COUNT).fill(fill)
const body = (extra = {}) => ({ id: toHex(crypto.randomBytes(16)), v: 1, h: { 'http-direct': hist(2), debrid: hist(-1) }, s: [10, 1, 2], ...extra })

async function statNode(b = body(), { writer = crypto.keyPair().publicKey, ts = DAY, room = 'stats:' + MONTH, bits = STATS_BITS, extra = {} } = {}) {
  const value = { v: 1, t: 'stat', room, ts, body: b, ...extra }
  value.nonce = await powMod.solve(powMod.powPayload(value, toHex(writer)), bits)
  return { value, from: { key: writer }, optimistic: true }
}

test('worklet constants mirror src/stats/community.ts', () => {
  assert.equal(statsMod.STATS_VERSION, community.STATS_VERSION)
  assert.equal(statsMod.BUCKET_COUNT, community.BUCKET_COUNT)
  assert.deepEqual(statsMod.PATHS, community.COMMUNITY_PATHS)
  assert.equal(statsMod.COUNT_MIN, community.COUNT_MIN)
  assert.equal(statsMod.COUNT_MAX, community.COUNT_MAX)
  assert.equal(statsMod.TOTAL_MAX, community.TOTAL_MAX)
  assert.equal(statsMod.monthOf(DAY), community.monthOf(DAY))
})

test('app and worklet validators agree on contributions', () => {
  const ok = body()
  const bad = [
    { ...ok, id: 'xyz' },
    { ...ok, v: 2 },
    { ...ok, s: [1, 2] },
    { ...ok, s: [1, 2, 999] },
    { ...ok, h: {} },
    { ...ok, h: { 'http-direct': hist().slice(1) } },
    { ...ok, h: { 'http-direct': hist(65) } },
    { ...ok, h: { 'http-direct': hist(-17) } },
    { ...ok, h: { 'http-direct': hist(1.5) } },
    { ...ok, h: { 'https://evil.example/x': hist() } },
    { ...ok, title: 'Frieren' },
    { ...ok, url: 'https://cdn.example/x.mp4' }
  ]
  assert.equal(statsBody(ok), true)
  assert.equal(community.isContribution(ok), true)
  for (const b of bad) {
    assert.equal(statsBody(b), false, JSON.stringify(b))
    assert.equal(community.isContribution(b), false, JSON.stringify(b))
  }
})

test('envelope: no auth, day-rounded timestamp inside the month, size bound', async () => {
  const n = await statNode()
  assert.equal(statsNode(n.value, MONTH), true)
  assert.equal(statsNode({ ...n.value, auth: { p: 'aa', h: 'bb' } }, MONTH), false, 'identity auth is refused')
  assert.equal(statsNode({ ...n.value, ts: DAY + 1234 }, MONTH), false, 'exact time is refused')
  assert.equal(statsNode({ ...n.value, ts: Date.UTC(2027, 1, 2) }, MONTH), false, 'other month')
  assert.equal(statsNode({ ...n.value, room: 'stats:2027-02' }, MONTH), false)
  assert.equal(statsNode({ ...n.value, t: 'comment' }, MONTH), false)
  assert.equal(statsNode({ ...n.value, nonce: undefined }, MONTH), false)
  assert.equal(statsNode({ ...n.value, body: { ...n.value.body, pad: 'x'.repeat(3000) } }, MONTH), false)
})

test('reducer: PoW checked, one contribution per writer, unique ids, writer acked as non-indexer', async () => {
  const apply = createStatsApply(MONTH)
  const view = new FakeView()
  const host = new FakeHost()

  const good = await statNode()
  await apply([good], view, host)
  assert.ok(await view.get('s/' + good.value.body.id))
  assert.deepEqual(host.added, [[toHex(good.from.key), false]])
  assert.deepEqual(host.acked, [toHex(good.from.key)])

  // Same writer again: refused (a fresh writer is used per contribution).
  const again = await statNode(body(), { writer: good.from.key })
  await apply([again], view, host)
  assert.equal(await view.get('s/' + again.value.body.id), null)

  // Same id from another writer: refused.
  const dup = await statNode({ ...body(), id: good.value.body.id })
  await apply([dup], view, host)
  assert.equal(host.added.length, 1)

  // Stored value holds the aggregates only.
  assert.deepEqual(Object.keys((await view.get('s/' + good.value.body.id)).value).sort(), ['h', 's'])

  // Not enough work.
  const cheap = await statNode(body(), { bits: 4 })
  if (powMod.check(powMod.powPayload(cheap.value, toHex(cheap.from.key)), cheap.value.nonce, STATS_BITS)) return
  await apply([cheap], view, host)
  assert.equal(await view.get('s/' + cheap.value.body.id), null)

})

test('merge: worklet sums like the app', () => {
  const a = body()
  const b = body({ h: { 'torrent-engine': hist(3) }, s: [4, 0, 1] })
  const out = { contributions: 0, h: {}, s: [0, 0, 0] }
  mergeInto(out, { h: a.h, s: a.s })
  mergeInto(out, { h: b.h, s: b.s })
  mergeInto(out, { h: { bogus: [1] }, s: [1, 1, 1] })
  assert.deepEqual(out, community.mergeContributions([a, b]))
})

test('contributions travel over the network and are summed by a third peer', { timeout: 120000 }, async (t) => {
  const testnet = await createTestnet(3)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huwa-stats-'))
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
  const a = await mk('a')
  const b = await mk('b')
  const c = await mk('c')

  // No identity is needed to contribute (and none is used).
  const ca = body()
  const cb = body({ h: { 'torrent-engine': hist(3) }, s: [5, 0, 0] })
  assert.equal(await a.contributeStats(ca), true)
  assert.equal(await b.contributeStats(cb), true)
  await assert.rejects(a.contributeStats({ ...ca, url: 'https://x' }))

  let got = null
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    got = await c.communityStats()
    if (got.contributions >= 2) break
    await new Promise((r) => setTimeout(r, 500))
  }
  assert.equal(got.contributions, 2)
  assert.deepEqual(got, community.mergeContributions([ca, cb]))

  // The stats swarm is not the identity swarm: separate key pair, separate store.
  assert.notEqual(toHex(a.statsSwarm.keyPair.publicKey), toHex(a.swarm.keyPair.publicKey))
  assert.notEqual(a.statsStore, a.store)
  assert.ok(DAY_MS > 0)
})
