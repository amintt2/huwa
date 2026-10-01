// A hello hinting a DM must not create a persistent conversation by itself (audit: any identity
// could make a device open and rejoin an Autobase + swarm topic at every start).
// Run: npm run test:p2p
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import createTestnet from 'hyperdht/testnet.js'
import worklet from '../../src/p2p/worklet/node.js'

const { HuwaNode, idTopic } = worklet
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huwa-dmprobe-'))
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
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

test('DM hint without a message opens nothing durable; a real message creates the request', { timeout: 120000 }, async (t) => {
  const testnet = await createTestnet(3)
  const nodes = []
  const mk = async (name) => {
    const n = new HuwaNode({ storage: path.join(tmp, name), bootstrap: testnet.bootstrap, deviceName: name })
    await n.ready()
    nodes.push(n)
    return n
  }
  t.after(async () => {
    for (const n of nodes) await n.close().catch(() => {})
    await testnet.destroy()
  })
  const alice = await mk('alice')
  const eve = await mk('eve')
  const { profile: pa } = await alice.createIdentity('Alice')
  const { profile: pe } = await eve.createIdentity('Eve')

  // Hint only.
  eve.dmHints.add(pa.key)
  eve._join(idTopic(pa.key), { server: false, client: true })
  eve._broadcastHello()
  assert.ok(await until(() => alice.dms.has(pe.key)), 'alice probes the DM base')
  await sleep(2000)
  assert.equal(await alice.local.get('conv/' + pe.key), null, 'no conversation from a bare hint')
  assert.deepEqual(await alice.listConversations(), [])

  // A real (decryptable) message turns the probe into a conversation request.
  await eve.sendMessage(pa.key, 'bonjour')
  const convs = await until(async () => {
    const l = await alice.listConversations()
    return l.length ? l : null
  })
  assert.ok(convs, 'conversation created by the message')
  assert.equal(convs[0].peer, pe.key)
  assert.equal(convs[0].request, true)
})
