// Multi-node integration test over a local HyperDHT testnet (no Internet needed).
// Run: npm run test:p2p
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import createTestnet from 'hyperdht/testnet.js'
import worklet from '../../src/p2p/worklet/node.js'

const { HuwaNode } = worklet
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huwa-it-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(fn, ms = 20000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await sleep(200)
  }
  return fn()
}

test('identity, comments, likes, DMs, labels, journal and pairing across nodes', { timeout: 180000 }, async (t) => {
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap
  const nodes = []
  const mk = async (name) => {
    const n = new HuwaNode({ storage: path.join(tmp, name), bootstrap, deviceName: name })
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

  const { profile: pa, phrase } = await alice.createIdentity('Alice')
  assert.equal(phrase.length, 24)
  assert.equal(pa.name, 'Alice')
  const { profile: pb } = await bob.createIdentity('Bob')
  assert.notEqual(pa.key, pb.key)

  // Comments: one Autobase per work, both peers converge.
  const bobSeen = []
  const stop = bob.watch('comments', '9999', (all) => bobSeen.push(all))
  const t0 = Date.now()
  const c1 = await alice.postComment({ target: 'ep:9999-e1', text: 'Premier !', spoiler: false })
  assert.equal(c1.author, pa.key)
  const synced = await until(() => bobSeen.length && bobSeen[bobSeen.length - 1].some((c) => c.id === c1.id))
  assert.ok(synced, 'bob sees alice comment')
  console.log('comment sync ms', Date.now() - t0)

  // Rate limit: a second comment within 15 s is refused locally.
  await assert.rejects(alice.postComment({ target: 'ep:9999-e1', text: 'Encore', spoiler: false }))

  // Bob replies and likes.
  const reply = await bob.postComment({ target: 'ep:9999-e1', parentId: c1.id, text: 'Salut', spoiler: false })
  await bob.toggleLike('9999', c1.id)
  const aliceView = await until(async () => {
    const all = await alice.listComments('9999')
    return all.length === 2 && all.find((c) => c.id === c1.id).likes === 1 ? all : null
  })
  assert.ok(aliceView, 'alice sees reply and like')
  assert.equal(aliceView.find((c) => c.id === reply.id).parentId, c1.id)
  stop()

  // Profiles are fetched from the personal base.
  const bobSeesAlice = await bob.getProfile(pa.key)
  assert.equal(bobSeesAlice && bobSeesAlice.name, 'Alice')

  // Direct messages: sealed boxes, conversation request on the recipient side.
  await alice.sendMessage(pb.key, 'coucou bob')
  const convs = await until(async () => {
    const list = await bob.listConversations()
    return list.length && list[0].lastText === 'coucou bob' ? list : null
  })
  assert.ok(convs, 'bob receives the DM')
  assert.equal(convs[0].request, true)
  assert.equal(convs[0].unread, 1)
  await bob.markRead(pa.key)
  const delivered = await until(async () => {
    const msgs = await alice.listMessages(pb.key)
    return msgs.length === 1 && msgs[0].delivered
  })
  assert.ok(delivered, 'alice sees the read receipt')

  // Moderation: labels and blocks from subscribed labelers.
  await alice.block(pb.key)
  await alice.report(c1.id, 'spam')
  await bob.subscribeLabeler(pa.key)
  const labels = await until(async () => {
    const l = await bob.listLabels()
    return l.length >= 2 ? l : null
  })
  assert.ok(labels.some((l) => l.val === 'hide' && l.target === pb.key))

  // Journal: hash chained, readable by others.
  await alice.appendJournal({ type: 'ep', work: '9999', unit: 1, ts: Date.now() })
  await alice.appendJournal({ type: 'ep', work: '9999', unit: 2, ts: Date.now() + 1 })
  const j = await until(async () => {
    const e = await bob.journal(pa.key)
    return e.filter((x) => x.type === 'ep').length === 2 ? e : null
  })
  assert.ok(j, 'bob reads alice journal')

  // Pairing a second device with blind-pairing, then revocation.
  const alice2 = await mk('alice2')
  const invite = await alice.pairingInvite()
  const p2 = await alice2.acceptPairing(invite)
  assert.equal(p2.key, pa.key)
  const devs = await until(async () => {
    const d = await alice.devices()
    return d.length === 2 ? d : null
  })
  assert.ok(devs, 'alice sees 2 devices')
  // The paired device can write to the personal base.
  await alice2.updateProfile({ bio: 'depuis le 2e appareil' })
  const bio = await until(async () => (alice.me() && alice.me().bio) || null)
  assert.equal(bio, 'depuis le 2e appareil')
  const other = devs.find((d) => !d.current)
  await alice.revokeDevice(other.key)
  const revoked = await until(async () => (await alice.devices()).find((d) => d.key === other.key && d.revoked))
  assert.ok(revoked)

  // Restore from the phrase on a fresh device finds the same personal base.
  const alice3 = await mk('alice3')
  const restored = await alice3.restoreIdentity(phrase)
  assert.equal(restored.key, pa.key)
  assert.equal(restored.name, 'Alice')
})
