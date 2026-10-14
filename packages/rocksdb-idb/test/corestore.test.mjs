// Corestore / Autobase / HuwaNode on rocksdb-idb (fake-indexeddb), in Node.
// The "browser" node runs on the adapter, the "mobile" node on native RocksDB (a directory).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
// rocksdb-native -> rocksdb-idb for hypercore-storage (as the browser bundle aliases it), fake IDB.
require('./register.cjs')
const RocksDB = require('../index.js')
const CorestoreStorage = require('hypercore-storage')
const Corestore = require('corestore')
const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const b4a = require('b4a')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rocksdb-idb-'))
let n = 0
const idbStorage = (nm) => new CorestoreStorage(new RocksDB(nm))

test('Corestore: append, close, reopen, read back', async () => {
  const nm = 'cs-' + process.pid + '-' + n++
  let store = new Corestore(idbStorage(nm))
  let core = store.get({ name: 'log' })
  await core.ready()
  const key = core.key
  for (let i = 0; i < 100; i++) await core.append(b4a.from('block ' + i))
  await store.close()

  store = new Corestore(idbStorage(nm))
  core = store.get({ name: 'log' })
  await core.ready()
  assert.ok(b4a.equals(core.key, key), 'same key pair from the stored primary key')
  assert.equal(core.length, 100)
  assert.equal(b4a.toString(await core.get(42)), 'block 42')
  await store.close()
})

test('Autobase (Hyperbee view): append, close, reopen, read back', async () => {
  const nm = 'ab-' + process.pid + '-' + n++
  const open = (store) => new Hyperbee(store.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false })
  async function apply(nodes, view) {
    for (const { value } of nodes) await view.put(value.k, value.v)
  }
  let store = new Corestore(idbStorage(nm))
  let base = new Autobase(store, null, { valueEncoding: 'json', open, apply })
  await base.ready()
  const key = base.key
  for (let i = 0; i < 20; i++) await base.append({ k: 'k' + i, v: i })
  await base.update()
  assert.equal((await base.view.get('k7')).value, 7)
  const length = base.length // system + view entries, not just the 20 appends
  await base.close()
  await store.close()

  store = new Corestore(idbStorage(nm))
  base = new Autobase(store, key, { valueEncoding: 'json', open, apply })
  await base.ready()
  await base.update()
  assert.equal(base.length, length)
  assert.equal((await base.view.get('k19')).value, 19)
  await base.close()
  await store.close()
})

test('HuwaNode: browser node (adapter) pairs with a mobile node (native) and replicates the home base', { timeout: 120000 }, async (t) => {
  const createTestnet = require('hyperdht/testnet.js')
  const { HuwaNode } = require('../../../src/p2p/worklet/node.js')
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap
  const nm = 'huwa-' + process.pid + '-' + n++
  const mobile = new HuwaNode({ storage: path.join(tmp, 'mobile'), bootstrap, deviceName: 'mobile' })
  let web = new HuwaNode({ storage: idbStorage(nm), statsStorage: () => idbStorage(nm + '-stats'), bootstrap, deviceName: 'web' })
  t.after(async () => {
    await web.close().catch(() => {})
    await mobile.close().catch(() => {})
    await testnet.destroy()
  })
  await mobile.ready()
  await web.ready()
  const { profile } = await mobile.createIdentity('Mobile')
  const invite = await mobile.pairingInvite()
  const t0 = Date.now()
  const me = await web.acceptPairing(invite)
  console.log('pairing ms', Date.now() - t0)
  assert.equal(me.key, profile.key)
  assert.equal(me.name, 'Mobile')
  await mobile.updateProfile({ bio: 'from mobile' })
  const deadline = Date.now() + 20000
  while (Date.now() < deadline && (!web.me() || web.me().bio !== 'from mobile')) await new Promise((r) => setTimeout(r, 100))
  assert.equal(web.me().bio, 'from mobile', 'home base replicates mobile -> web')

  // The browser node survives a restart: identity and home base come back from IndexedDB.
  await web.close()
  web = new HuwaNode({ storage: idbStorage(nm), bootstrap, deviceName: 'web' })
  await web.ready()
  assert.equal(web.me().key, profile.key)
  assert.equal(web.me().bio, 'from mobile')
  assert.equal((await web.devices()).length, 2)
})
