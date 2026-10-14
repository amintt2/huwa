// HuwaNode seam: injected storage (any Corestore storage) and swarm factory (the browser runs the
// node over @hyperswarm/dht-relay and an IndexedDB-backed RocksDB). Run: npm run test:p2p
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import createTestnet from 'hyperdht/testnet.js'
import Hyperswarm from 'hyperswarm'
import CorestoreStorage from 'hypercore-storage'
import worklet from '../../src/p2p/worklet/node.js'

const { HuwaNode } = worklet
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huwa-seam-'))

test('injected storage and swarmFactory are used for the main and stats networks', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  const roles = []
  let statsOpened = 0
  const node = new HuwaNode({
    storage: new CorestoreStorage(path.join(tmp, 'main')),
    statsStorage: () => {
      statsOpened++
      return new CorestoreStorage(path.join(tmp, 'stats'))
    },
    swarmFactory: (opts, info) => {
      roles.push(info.role)
      return new Hyperswarm(opts)
    },
    bootstrap: testnet.bootstrap,
    deviceName: 'seam'
  })
  t.after(async () => {
    await node.close().catch(() => {})
    await testnet.destroy()
  })
  await node.ready()
  assert.deepEqual(roles, ['main'])
  assert.equal(statsOpened, 0, 'stats storage is opened lazily')

  const { profile } = await node.createIdentity('Seam')
  assert.equal(profile.name, 'Seam')

  node._statsNet()
  assert.deepEqual(roles, ['main', 'stats'])
  assert.equal(statsOpened, 1)
  await node.statsStore.ready()
})

test('a storage object without statsStorage refuses stats instead of writing next to nothing', async () => {
  const node = new HuwaNode({ storage: new CorestoreStorage(path.join(tmp, 'nostats')), swarmFactory: () => ({}) })
  assert.throws(() => node._statsNet(), /statistiques/)
  await node.store.close()
})

test('a directory keeps the previous defaults (mobile path unchanged)', async () => {
  const dir = path.join(tmp, 'dir')
  const node = new HuwaNode({ storage: dir })
  assert.equal(node.statsStorage, dir + '-stats')
  await node.store.close()
})
