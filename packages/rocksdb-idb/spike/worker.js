// Spike S2 worker (bundled by spike/build.mjs): the real Huwa node (src/p2p/worklet/node.js) in a
// browser Worker, on rocksdb-idb (IndexedDB) and @hyperswarm/dht-relay (non-custodial, WebSocket).
// Driven by postMessage({ id, cmd, args }) from spike/index.html (itself driven by Playwright).
const RocksDB = require('rocksdb-idb')
const CorestoreStorage = require('hypercore-storage')
const Corestore = require('corestore')
const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const { createRelaySwarmFactory } = require('./relay-swarm.js')
const sodium = require('sodium-universal')
const b4a = require('b4a')
const { blake2b } = require('@noble/hashes/blake2.js')
const { HuwaNode } = require('../../../src/p2p/worklet/node.js')
const pow = require('../../../src/p2p/worklet/pow.js')

const now = () => performance.now()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const storage = (name) => new CorestoreStorage(new RocksDB(name))

let node = null
const sockets = []

const handlers = {
  // 3a: Corestore + Autobase on rocksdb-idb, append, close, reopen, read back.
  async storageWrite({ name, blocks = 500, entries = 100 }) {
    const out = {}
    let t = now()
    const db = new RocksDB(name)
    const store = new Corestore(new CorestoreStorage(db))
    const core = store.get({ name: 'log' })
    await core.ready()
    out.openMs = now() - t
    t = now()
    const payload = b4a.alloc(1024, 7)
    for (let i = 0; i < blocks; i++) await core.append(b4a.concat([b4a.from(String(i).padStart(8, '0')), payload]))
    out.appendMs = now() - t
    out.appendPerSec = Math.round(blocks / (out.appendMs / 1000))
    t = now()
    const batch = []
    for (let i = 0; i < blocks; i++) batch.push(b4a.alloc(256, i % 256))
    await core.append(batch)
    out.batchAppendMs = now() - t
    const open = (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false })
    const apply = async (nodes, view) => {
      for (const { value } of nodes) await view.put(value.k, value.v)
    }
    const base = new Autobase(store.namespace('base'), null, { valueEncoding: 'json', open, apply })
    await base.ready()
    t = now()
    for (let i = 0; i < entries; i++) await base.append({ k: 'k' + String(i).padStart(4, '0'), v: { i, text: 'entry ' + i } })
    await base.update()
    out.autobaseAppendMs = now() - t
    out.autobasePerSec = Math.round(entries / (out.autobaseAppendMs / 1000))
    out.coreKey = b4a.toString(core.key, 'hex')
    out.baseKey = b4a.toString(base.key, 'hex')
    out.coreLength = core.length
    out.baseLength = base.length
    out.idb = { ...db.persistenceStats }
    t = now()
    await base.close()
    await store.close()
    out.closeMs = now() - t
    return out
  },

  async storageRead({ name, coreKey, baseKey, blocks = 500, entries = 100 }) {
    const out = {}
    let t = now()
    const store = new Corestore(storage(name))
    const core = store.get({ name: 'log' })
    await core.ready()
    out.reopenMs = now() - t
    out.sameKey = b4a.toString(core.key, 'hex') === coreKey
    out.coreLength = core.length
    t = now()
    let ok = true
    for (let i = 0; i < blocks; i += 37) {
      const blk = await core.get(i)
      if (b4a.toString(blk.subarray(0, 8)) !== String(i).padStart(8, '0')) ok = false
    }
    out.readOk = ok
    out.readMs = now() - t
    const open = (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false })
    const apply = async (nodes, view) => {
      for (const { value } of nodes) await view.put(value.k, value.v)
    }
    const base = new Autobase(store.namespace('base'), b4a.from(baseKey, 'hex'), { valueEncoding: 'json', open, apply })
    await base.ready()
    await base.update()
    const last = await base.view.get('k' + String(entries - 1).padStart(4, '0'))
    out.autobaseOk = !!last && last.value.i === entries - 1
    let count = 0
    for await (const e of base.view.createReadStream()) if (e) count++
    out.viewEntries = count
    await base.close()
    await store.close()
    return out
  },

  // 3c: proof of work (blake2b-256 over payload || nonce) as src/p2p/worklet/pow.js does it.
  async pow({ ms = 1500, bits = [8, 12, 16], runs = 4 }) {
    const out = { blake2bWasmLoaded: !!require('blake2b').WASM_LOADED, blake2bWasmSupported: !!require('blake2b').WASM_SUPPORTED }
    const payload = pow.commentPowPayload('ab'.repeat(32), 'ep:12-e3', 'Un commentaire de taille normale pour le banc.')
    const buf = b4a.concat([b4a.from(payload), b4a.alloc(4)])
    const hash = b4a.alloc(32)
    let n = 0
    let t0 = now()
    while (now() - t0 < ms) {
      for (let i = 0; i < 1000; i++) {
        buf[buf.length - 1] = i & 255
        sodium.crypto_generichash(hash, buf)
      }
      n += 1000
    }
    out.sodiumHashesPerSec = Math.round(n / ((now() - t0) / 1000))
    n = 0
    t0 = now()
    while (now() - t0 < ms) {
      for (let i = 0; i < 1000; i++) {
        buf[buf.length - 1] = i & 255
        blake2b(buf, { dkLen: 32 })
      }
      n += 1000
    }
    out.nobleHashesPerSec = Math.round(n / ((now() - t0) / 1000))
    out.solve = {}
    for (const b of bits) {
      const times = []
      for (let r = 0; r < runs; r++) {
        const t = now()
        await pow.solve(payload + ' #' + r, b)
        times.push(now() - t)
      }
      out.solve[b] = { avgMs: Math.round(times.reduce((a, x) => a + x, 0) / times.length), maxMs: Math.round(Math.max(...times)) }
    }
    return out
  },

  // 3b: the real HuwaNode, through the relay.
  async nodeStart({ relay, name, deviceName = 'navigateur', debug = false }) {
    if (debug) process.env.RELAY_DEBUG = '1'
    const swarmFactory = createRelaySwarmFactory({ url: relay, sockets })
    const t = now()
    node = new HuwaNode({
      storage: storage(name),
      statsStorage: () => storage(name + '-stats'),
      swarmFactory,
      deviceName,
      log: (...a) => console.log('[huwa]', ...a)
    })
    await node.ready()
    return { readyMs: now() - t, me: node.me() || null }
  },

  async accept({ invite }) {
    const t = now()
    const me = await node.acceptPairing(invite)
    return { ms: now() - t, me }
  },

  async me() {
    return { me: node.me() || null, peers: node.swarm ? node.swarm.connections.size : 0 }
  },

  async waitMe({ field, value, ms = 30000 }) {
    const t = now()
    while (now() - t < ms) {
      const me = node.me()
      if (me && me[field] === value) return { ms: now() - t, me }
      await sleep(50)
    }
    throw new Error('timeout waiting for me.' + field)
  },

  async comment({ work, text }) {
    const t = now()
    const c = await node.postComment({ target: 'ep:' + work + '-e1', text, spoiler: false })
    return { ms: now() - t, id: c.id }
  },

  async waitComment({ work, id, ms = 30000 }) {
    const t = now()
    while (now() - t < ms) {
      const list = await node.listComments(work)
      if (list.some((c) => c.id === id)) return { ms: now() - t }
      await sleep(100)
    }
    throw new Error('timeout waiting for comment ' + id)
  },

  async devices() {
    return node.devices()
  },

  // 3d (test only): the secrets this browser holds, so the harness can look for them on the relay.
  async secrets() {
    const s = node.secret
    const hex = (b) => b4a.toString(b, 'hex')
    return {
      swarmSecretKey: hex(node.swarm.keyPair.secretKey),
      deviceSecretKey: s.device.secretKey,
      boxSeed: s.boxSeed,
      corestorePrimaryKey: hex(node.store.primaryKey),
      homeWriterSecretKey: node.home.local.keyPair ? hex(node.home.local.keyPair.secretKey) : null
    }
  },

  // "Create an account in this browser": recovery phrase + identity derivation in the browser.
  async identityTest({ relay, name }) {
    const n = new HuwaNode({ storage: storage(name), swarmFactory: createRelaySwarmFactory({ url: relay, sockets }), deviceName: 'navigateur' })
    await n.ready()
    const t = now()
    const { profile, phrase } = await n.createIdentity('Compte web')
    const ms = now() - t
    await n.close()
    return { ms, words: phrase.length, name: profile.name, key: profile.key }
  },

  async nodeClose() {
    if (node) await node.close()
    node = null
    for (const ws of sockets) ws.close()
    sockets.length = 0
    return true
  }
}

self.onmessage = async (e) => {
  const { id, cmd, args } = e.data
  try {
    const v = await handlers[cmd](args || {})
    self.postMessage({ id, ok: true, v })
  } catch (err) {
    self.postMessage({ id, ok: false, e: (err && err.stack) || String(err) })
  }
}
self.postMessage({ ready: true })
