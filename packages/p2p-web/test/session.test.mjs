// The browser node's worker logic (src/p2p/web/{session,host,keystore,relay-dht}.js) in Node:
// fake-indexeddb, Node's WebCrypto and WebSocket, the real gateway (services/huwa-gateway) on a
// local HyperDHT testnet, and a "phone" HuwaNode on native storage. The same flows run in Chromium
// in e2e/.
import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { WebSession } = require('../../../src/p2p/web/session.js')
const { createHost } = require('../../../src/p2p/web/host.js')
const { KeyStore } = require('../../../src/p2p/web/keystore.js')
const { HuwaNode } = require('../../../src/p2p/worklet/node.js')
const { startGateway } = require('../../../services/huwa-gateway')

const quiet = { error() {}, warn() {}, info() {}, debug() {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn, ms, what) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await sleep(100)
  }
  throw new Error('timeout: ' + what)
}

/** A tab: talks to the host over a MessageChannel, like client.ts does. */
function tab(host) {
  const { port1, port2 } = new MessageChannel()
  host.connect(port2)
  let id = 0
  const pending = new Map()
  const events = []
  port1.onmessage = (e) => {
    const m = e.data
    if (m.t === 'reply') {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else events.push(m)
  }
  return {
    events,
    async call(m, ...a) {
      const r = await new Promise((resolve) => {
        pending.set(++id, resolve)
        port1.postMessage({ t: 'call', id, m, a })
      })
      if (!r.ok) {
        const err = new Error(r.e)
        err.code = r.code
        throw err
      }
      return r.v
    },
    close() {
      port1.close()
    }
  }
}

async function dumpIdb() {
  const out = []
  for (const { name } of await indexedDB.databases()) {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(name)
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
    for (const store of db.objectStoreNames) {
      const values = await new Promise((resolve) => {
        const r = db.transaction(store).objectStore(store).getAll()
        r.onsuccess = () => resolve(r.result)
      })
      for (const v of values) out.push(Buffer.from(v instanceof Uint8Array ? v : JSON.stringify(v, (k, x) => (x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x)) ?? ''))
    }
    db.close()
  }
  return Buffer.concat(out)
}

let gw
let phone
let tmp

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huwa-web-session-'))
  gw = await startGateway({ port: 0, testnet: 3, logger: quiet })
  phone = new HuwaNode({ storage: path.join(tmp, 'phone'), bootstrap: gw.bootstrap, deviceName: 'iPhone', log: process.env.DEBUG_SESSION ? (...a) => console.log('[phone]', ...a) : undefined })
  await phone.ready()
  await phone.createIdentity('Mobile')
})

test.after(async () => {
  await phone.close().catch(() => {})
  await gw.close().catch(() => {})
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function wipeBrowser() {
  for (const { name } of await indexedDB.databases()) {
    await new Promise((resolve) => {
      const r = indexedDB.deleteDatabase(name)
      r.onsuccess = r.onerror = r.onblocked = () => resolve()
    })
  }
}

const workers = []
test.afterEach(async () => {
  for (const w of workers.splice(0)) await w.session.close().catch(() => {})
  await wipeBrowser()
})

function worker() {
  const session = new WebSession({
    gateway: 'ws://127.0.0.1:' + gw.port + '/p2p',
    deviceName: 'Chrome sur macOS',
    log: process.env.DEBUG_SESSION ? (...a) => console.log('[session]', ...a) : () => {},
    onevent: (ev) => host.onNodeEvent(ev),
    onnode: (n) => host.attachNode(n)
  })
  const host = createHost(session)
  const w = { session, host }
  workers.push(w)
  return w
}

test('logged out: no node, cheap answers; login methods need a session', async () => {
  const { session, host } = worker()
  const t = tab(host)
  const hello = await t.call('hello')
  assert.equal(hello.session.state, 'idle')
  assert.equal(hello.status.state, 'ready')
  assert.equal(session.node, null)
  await assert.rejects(t.call('devices'), (e) => e.code === 'NO_SESSION')
  await t.call('watch', 1, 'labels') // registered, served once a node runs
  t.close()
  await session.close()
})

test('QR link (pairing through the gateway), encrypted storage, comments both ways, two tabs, logout revokes', async () => {
  const { session, host } = worker()
  const a = tab(host)
  const b = tab(host)
  await a.call('session.begin', { mode: 'device' })
  const invite = await phone.pairingInvite()
  let t0 = Date.now()
  const me = await a.call('acceptPairing', invite)
  const pairingMs = Date.now() - t0
  assert.equal(me.key, phone.me().key)
  console.log('pairing', pairingMs, 'ms')
  const devices = await phone.devices()
  assert.ok(devices.some((d) => d.name === 'Chrome sur macOS'))

  // The second tab shares the same node (one SharedWorker).
  assert.equal((await b.call('me')).key, me.key)

  // web -> phone
  const work = String(800000 + Math.floor(Math.random() * 99999))
  t0 = Date.now()
  const c = await a.call('postComment', { target: 'ep:' + work + '-e1', text: 'Depuis le navigateur', spoiler: false })
  await waitFor(async () => (await phone.listComments(work)).some((x) => x.id === c.id), 30000, 'comment web -> phone')
  console.log('comment web -> phone', Date.now() - t0, 'ms')
  // phone -> web, pushed to the tab that watches (tab b)
  const work2 = String(Number(work) + 1)
  await b.call('watch', 7, 'comments', work2)
  t0 = Date.now()
  const pc = await phone.postComment({ target: 'ep:' + work2 + '-e1', text: 'Depuis le téléphone', spoiler: false })
  await waitFor(() => b.events.some((e) => e.ev === 'sub' && e.sid === 7 && e.data.some((x) => x.id === pc.id)), 30000, 'comment phone -> web')
  console.log('comment phone -> web', Date.now() - t0, 'ms')
  assert.ok(!a.events.some((e) => e.ev === 'sub' && e.sid === 7), 'sub events only reach the tab that watches')

  // At rest: no secret of the browser node in IndexedDB.
  const secret = session.node.secret
  const raw = await dumpIdb()
  for (const [k, v] of Object.entries({ device: secret.device.secretKey, box: secret.boxSeed, proof: secret.proof })) {
    assert.equal(raw.indexOf(Buffer.from(v, 'hex')), -1, k + ' (bytes)')
    assert.equal(raw.indexOf(Buffer.from(v)), -1, k + ' (hex)')
  }
  assert.equal(raw.indexOf(Buffer.from('Depuis le navigateur')), -1, 'values are encrypted')
  const deviceKey = await a.call('session.deviceKey')

  // Logout: signed remove-device seen by the phone, then everything is wiped.
  const out = await a.call('session.logout')
  assert.equal(out.revoked, true)
  assert.equal(out.info.state, 'idle')
  await waitFor(async () => (await phone.devices()).some((d) => d.key === deviceKey && d.revoked), 20000, 'phone sees the revocation')
  const names = (await indexedDB.databases()).map((d) => d.name)
  assert.ok(!names.includes('huwa-p2p') && !names.includes('huwa-keys'), 'wiped: ' + names)
  a.close()
  b.close()
  await session.close()
})

test('device-mode session restarts from IndexedDB with the stored key', async () => {
  let w = worker()
  let t = tab(w.host)
  await t.call('session.begin', { mode: 'device' })
  const inv = await phone.pairingInvite()
  const me = await t.call('acceptPairing', inv)
  t.close()
  await w.session.close()
  // New worker (all tabs were closed): the account comes back without user action.
  w = worker()
  t = tab(w.host)
  const hello = await t.call('hello')
  assert.equal(hello.session.state, 'ready')
  assert.equal(hello.me.key, me.key)
  await t.call('session.logout', { waitMs: 3000 })
  t.close()
  await w.session.close()
})

test('public computer: memory only, nothing in IndexedDB; phrase restore does not persist the phrase', async () => {
  const { session, host } = worker()
  const t = tab(host)
  await t.call('session.begin', { mode: 'memory' })
  // A second account (restored from its phrase while its phone is online).
  const other = new HuwaNode({ storage: path.join(tmp, 'other'), bootstrap: gw.bootstrap, deviceName: 'Pixel' })
  await other.ready()
  const { phrase, profile } = await other.createIdentity('Autre')
  const restored = await t.call('restoreIdentity', phrase)
  assert.equal(restored.key, profile.key)
  const raw = await dumpIdb()
  assert.equal(raw.indexOf(Buffer.from(phrase.join(' '))), -1)
  assert.equal(raw.indexOf(Buffer.from(phrase.slice(0, 3).join(' '))), -1)
  const names = (await indexedDB.databases()).map((d) => d.name)
  assert.ok(!names.includes('huwa-p2p'), 'memory mode writes no database: ' + names)
  await t.call('session.logout', { waitMs: 3000 })
  await other.close()
  t.close()
  await session.close()
})

test('passkey lock: locked at start, unlocked with the PRF key, wrong key refused', async () => {
  const subtle = globalThis.crypto.subtle
  const { kekFromPrf } = require('../../../src/p2p/web/keystore.js')
  let w = worker()
  let t = tab(w.host)
  await t.call('session.begin', { mode: 'device' })
  const me = await t.call('acceptPairing', await phone.pairingInvite())
  const prf = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const kek = await kekFromPrf(prf)
  assert.equal(kek.extractable, false)
  await t.call('session.enablePasskey', kek, { credentialId: 'cred', prfSalt: 'salt' })
  const ks = new KeyStore()
  assert.equal((await ks.load()).mode, 'passkey')
  ks.close()
  t.close()
  await w.session.close()

  w = worker()
  t = tab(w.host)
  assert.equal((await t.call('hello')).session.state, 'locked')
  await assert.rejects(t.call('devices'), (e) => e.code === 'LOCKED')
  await assert.rejects(t.call('session.unlock', await kekFromPrf(new Uint8Array(32))), (e) => e.code === 'BAD_KEY')
  const info = await t.call('session.unlock', await kekFromPrf(prf))
  assert.equal(info.state, 'ready')
  assert.equal(info.me.key, me.key)
  await t.call('session.lock')
  assert.equal((await t.call('session.info')).state, 'locked')
  await t.call('session.unlock', kek)
  await t.call('session.logout', { waitMs: 3000 })
  t.close()
  await w.session.close()
  void subtle
})
