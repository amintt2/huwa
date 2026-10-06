// Huwa relay (services/blind-peer + src/p2p/worklet/relay.js): a wiped phone restores its account
// from the phrase while no other device is online, and the relay's storage policy holds.
// Run: npm run test:p2p
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import createTestnet from 'hyperdht/testnet.js'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import BlindPeering from 'blind-peering'
import worklet from '../../src/p2p/worklet/node.js'
import relayMod from '../../src/p2p/worklet/relay.js'

const require = createRequire(import.meta.url)
const { start: startRelay } = require('../../services/blind-peer/server.js')
const { HuwaNode } = worklet
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huwa-relay-'))
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, ms, what) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return
    await sleep(200)
  }
  assert.fail('timeout: ' + what)
}
const quiet = () => {}

test('relay keys are validated and normalised', () => {
  const { parseRelayKeys } = relayMod
  const z32 = 'crxbmxy8gcok4eaou5mukg8phmkjf5b95xigyazrk1pctm1skyey'
  const hex = Buffer.from(require('hypercore-id-encoding').decode(z32)).toString('hex')
  assert.deepEqual(parseRelayKeys([z32, hex, ' ' + z32 + ' ', 'nope', 42, '']), [z32])
  assert.deepEqual(parseRelayKeys(null), [])
})

test('a wiped phone restores from the phrase through the relay alone', { timeout: 180000 }, async (t) => {
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap
  const relay = await startRelay(
    { storage: path.join(tmp, 'relay'), port: 0, bootstrap, maxStorageMb: 100, groupQuotaMb: 50, maxIdleDays: 120, sweepMinutes: 0, trustedPeers: [], pushGatewayKeys: [], healthPort: null },
    { log: quiet }
  )
  const relays = { enabled: true, keys: [relay.publicKey] }
  const nodes = new Set()
  const mk = async (name, opts = {}) => {
    const n = new HuwaNode({ storage: path.join(tmp, name), bootstrap, deviceName: name, relays, ...opts })
    await n.ready()
    nodes.add(n)
    return n
  }
  t.after(async () => {
    for (const n of nodes) await n.close().catch(() => {})
    await relay.close()
    await testnet.destroy()
  })

  const alice = await mk('alice')
  const { profile: pa, phrase } = await alice.createIdentity('Alice')
  await alice.updateProfile({ bio: 'Fan de Frieren' })
  const day = 24 * 3600 * 1000
  await alice.appendJournal({ type: 'ep', work: '154587', unit: 1, ts: Date.now() - 2 * day })
  await alice.appendJournal({ type: 'ep', work: '154587', unit: 2, ts: Date.now() - day })
  const journalA = await alice.journal()
  assert.equal(journalA.length, 2)

  // Everything of the account reaches the relay: pointer + every block of the personal base.
  const homeLocal = alice.home.local
  const pointer = alice.pointer
  const relayHas = async (key, length) => {
    const rec = await relay.bp.db.getCoreRecord(key)
    if (!rec) return false
    const core = relay.bp.store.get({ key })
    await core.ready()
    const ok = core.length >= length && core.contiguousLength >= length
    await core.close()
    return ok
  }
  await until(() => relayHas(pointer.key, pointer.length), 60000, 'pointer on the relay')
  await until(() => relayHas(homeLocal.key, homeLocal.length), 60000, 'personal base on the relay')
  const status = alice.relayStatus()
  assert.equal(status.enabled, true)
  assert.equal(status.connected, 1)

  const homeA = alice.secret.home
  nodes.delete(alice)
  await alice.close() // the only device of the account is wiped

  // Control: without the relay, nobody answers.
  const bare = await mk('no-relay', { relays: { enabled: false, keys: [relay.publicKey] }, restoreLookupMs: 5000 })
  await assert.rejects(bare.restoreIdentity(phrase), (err) => err.code === 'RESTORE_NOT_FOUND')
  nodes.delete(bare)
  await bare.close()

  const phone = await mk('phone', { restoreLookupMs: 20000 })
  const restored = await phone.restoreIdentity(phrase)
  assert.equal(restored.key, pa.key)
  assert.equal(phone.secret.home, homeA, 'joined the original personal base')
  await until(() => phone.me() && phone.me().name === 'Alice' && phone.me().bio === 'Fan de Frieren', 30000, 'profile restored')
  await until(async () => (await phone.journal()).length === 2, 30000, 'journal restored')
  assert.deepEqual(
    (await phone.journal()).map((e) => e.unit),
    [1, 2]
  )
  // The restored device writes into the same base (bound writer), and the relay keeps it too.
  await phone.appendJournal({ type: 'ep', work: '154587', unit: 3, ts: Date.now() })
  assert.equal((await phone.journal()).length, 3)
})

test('relay policy: quota per group and expiry of forgotten cores', { timeout: 120000 }, async (t) => {
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap
  const relay = await startRelay(
    // 10 kB per group, so a 20 kB core goes over.
    { storage: path.join(tmp, 'relay-quota'), port: 0, bootstrap, maxStorageMb: 100, groupQuotaMb: 0.01, maxIdleDays: 120, sweepMinutes: 0, trustedPeers: [], pushGatewayKeys: [], healthPort: null },
    { log: quiet }
  )
  const store = new Corestore(path.join(tmp, 'client-quota'))
  const swarm = new Hyperswarm({ bootstrap })
  const peering = new BlindPeering(swarm.dht, store, { blindPeers: [{ key: relay.publicKey }] })
  t.after(async () => {
    await peering.close()
    await swarm.destroy()
    await store.close()
    await relay.close()
    await testnet.destroy()
  })

  const big = store.get({ name: 'big' })
  const small = store.get({ name: 'small' })
  await big.ready()
  await small.ready()
  for (let i = 0; i < 20; i++) await big.append(Buffer.alloc(1000, i))
  await small.append(Buffer.from('hello'))
  const group = store.get({ name: 'group' }) // stands for a personal base key (referrer)
  await group.ready()
  await peering.addCore(big, { referrer: group.key, priority: 1 })
  await peering.addCore(small, { priority: 1 })

  const record = (core) => relay.bp.db.getCoreRecord(core.key)
  await until(async () => {
    await relay.bp.flush()
    const a = await record(big)
    const b = await record(small)
    return a && b && a.length === 20 && a.bytesAllocated === big.byteLength && b.bytesAllocated === small.byteLength
  }, 60000, 'cores downloaded by the relay')

  await relay.policy.sweep()
  const afterQuota = await record(big)
  assert.ok(afterQuota.bytesAllocated <= 10_000, 'group brought under its quota (' + afterQuota.bytesAllocated + ')')
  assert.equal((await record(small)).bytesAllocated, small.byteLength, 'other groups untouched')
  const groups = await relay.policy.groups()
  assert.ok(groups.every((g) => g.bytes <= 10_000))

  // 121 days later, nobody asked for these cores any more: deleted.
  const realNow = relay.policy.now
  relay.policy.now = () => realNow() + 121 * 24 * 3600 * 1000
  await relay.policy.sweep()
  assert.equal(await record(big), null)
  assert.equal(await record(small), null)
  assert.equal(relay.policy.stats.expired, 2)
})

test('a pending message reaches its recipient through the relay', { timeout: 180000 }, async (t) => {
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap
  const relay = await startRelay(
    { storage: path.join(tmp, 'relay-dm'), port: 0, bootstrap, maxStorageMb: 100, groupQuotaMb: 50, maxIdleDays: 120, sweepMinutes: 0, trustedPeers: [], pushGatewayKeys: [], healthPort: null },
    { log: quiet }
  )
  const relays = { enabled: true, keys: [relay.publicKey] }
  const nodes = new Set()
  const mk = async (name) => {
    const n = new HuwaNode({ storage: path.join(tmp, 'dm-' + name), bootstrap, deviceName: name, relays })
    await n.ready()
    nodes.add(n)
    return n
  }
  const close = async (n) => {
    nodes.delete(n)
    await n.close()
  }
  t.after(async () => {
    for (const n of nodes) await n.close().catch(() => {})
    await relay.close()
    await testnet.destroy()
  })

  const alice = await mk('alice')
  const bob = await mk('bob')
  await alice.createIdentity('Alice')
  const { profile: pb } = await bob.createIdentity('Bob')
  const pa = alice.me()
  await alice.sendMessage(pb.key, 'premier message')
  await until(async () => (await bob.listMessages(pa.key)).some((m) => m.text === 'premier message'), 60000, 'first message (both online)')

  await close(bob) // Bob's phone is off
  const sent = await alice.sendMessage(pb.key, 'pendant ton absence')
  const dm = alice.dms.get(pb.key).base
  await until(async () => {
    const rec = await relay.bp.db.getCoreRecord(dm.local.key)
    if (!rec) return false
    const core = relay.bp.store.get({ key: dm.local.key })
    await core.ready()
    const ok = core.contiguousLength >= dm.local.length
    await core.close()
    return ok
  }, 60000, 'message on the relay')
  await close(alice) // and then Alice's

  const bobBack = await mk('bob')
  await until(async () => (await bobBack.listMessages(pa.key)).some((m) => m.id === sent.id && m.text === 'pendant ton absence'), 60000, 'pending message delivered by the relay')
})
