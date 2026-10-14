// The browser's account session, inside the node worker: which storage the node runs on, the
// at-rest key (keystore.js), lock / unlock, and logout (signed remove-device, then wipe).
//
// States: 'idle'    no account in this browser and no node (logged-out visitor)
//         'locked'  an account protected by a passkey: waiting for unlock(kek)
//         'ready'   the node runs (it may have no identity yet: a login flow is in progress)
//         'error'   the node failed to start (info().error)
// Storage modes: 'device' (IndexedDB, encrypted with the DEK), 'passkey' (same, DEK behind the
// passkey), 'memory' ("public computer": nothing written to disk, gone with the worker).
const RocksDB = require('rocksdb-idb')
const CorestoreStorage = require('hypercore-storage')
const b4a = require('b4a')
const { HuwaNode } = require('../worklet/node.js')
const { KeyStore, codedError } = require('./keystore')
const { createRelaySwarmFactory } = require('./relay-dht')

const MAIN_DB = 'huwa-p2p'
const STATS_DB = 'huwa-p2p-stats'
const REVOKE_SYNC_MS = 12_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class WebSession {
  /**
   * @param {object} o
   * @param {string} o.gateway  wss://…/p2p
   * @param {string} [o.deviceName]
   * @param {IDBFactory} [o.indexedDB]
   * @param {Crypto} [o.crypto]
   * @param {typeof WebSocket} [o.WebSocket]
   * @param {(ev: object) => void} [o.onevent]  node events + { ev: 'session', data: info() }
   * @param {(...a) => void} [o.log]
   * @param {(n: HuwaNode | null) => void} [o.onnode]  called when the running node changes
   */
  constructor({ gateway, deviceName = 'navigateur', indexedDB = globalThis.indexedDB, crypto = globalThis.crypto, WebSocket = globalThis.WebSocket, onevent = () => {}, log = () => {}, onnode = () => {}, nodeOptions = {} }) {
    this.gateway = gateway
    this.deviceName = deviceName
    this.idb = indexedDB
    this.crypto = crypto
    this.WebSocket = WebSocket
    this.onevent = onevent
    this.log = log
    this.onnode = onnode
    this.nodeOptions = nodeOptions
    this.keys = new KeyStore({ indexedDB, crypto })
    this.state = 'idle'
    this.mode = null
    this.meta = null
    this.node = null
    this.dhts = []
    this.error = null
    this.storageError = null
    this._busy = Promise.resolve()
    this._inited = null
  }

  /** Serializes state changes. */
  _serial(fn) {
    const run = this._busy.then(fn, fn)
    this._busy = run.catch(() => {})
    return run
  }

  info() {
    const me = this.node && this.node.me ? this.node.me() || null : null
    return {
      state: this.state,
      mode: this.mode,
      hasAccount: !!me || this.state === 'locked',
      me,
      gateway: this.gateway,
      deviceName: this.deviceName,
      passkey: this.meta && this.meta.mode === 'passkey' ? { credentialId: this.meta.credentialId, prfSalt: this.meta.prfSalt } : null,
      online: this.dhts.some((d) => d.online),
      error: this.error,
      storageError: this.storageError
    }
  }

  _emit() {
    this.onevent({ ev: 'session', data: this.info() })
  }

  init() {
    if (!this._inited) {
      this._inited = this._serial(async () => {
        this.meta = await this.keys.load()
        if (!this.meta) return this._set('idle')
        this.mode = this.meta.mode
        if (this.meta.deviceName) this.deviceName = this.meta.deviceName
        if (this.meta.mode === 'passkey') return this._set('locked')
        const dek = await this.keys.unlockDevice()
        await this._start(dek, 'device')
      })
    }
    return this._inited
  }

  _set(state) {
    this.state = state
    this._emit()
  }

  _storage(name, dek, mode) {
    const opts = {
      onerror: (err) => {
        this.storageError = { code: err.code || 'IDB_ERROR', message: err.message }
        this.log('storage error', err.code, err.message)
        this._emit()
      }
    }
    if (mode === 'memory') {
      opts.indexedDB = null
      opts.lock = false
    } else {
      opts.indexedDB = this.idb
      opts.cipher = RocksDB.aesGcmCipher(dek, { crypto: this.crypto })
    }
    return new CorestoreStorage(new RocksDB(name, opts))
  }

  async _start(dek, mode) {
    this.mode = mode
    this.error = null
    this.storageError = null
    const swarmFactory = createRelaySwarmFactory({
      url: this.gateway,
      WebSocket: this.WebSocket,
      dhts: this.dhts,
      log: this.log,
      onstate: () => this._emit()
    })
    const node = new HuwaNode({
      storage: this._storage(MAIN_DB, dek, mode),
      statsStorage: () => this._storage(STATS_DB, dek, mode),
      swarmFactory,
      deviceName: this.deviceName,
      onevent: (ev) => {
        this.onevent(ev)
        if (ev.ev === 'me') this._emit()
      },
      log: this.log,
      ...this.nodeOptions
    })
    this.node = node
    try {
      await node.ready()
    } catch (err) {
      this.node = null
      await node.close().catch(() => {})
      this.error = { code: err.code || 'START_FAILED', message: err.message }
      this._set('error')
      throw err
    }
    this.onnode(node)
    this._set('ready')
    if (mode !== 'memory') require('rocksdb-idb').requestPersist().catch(() => {})
  }

  async _stop() {
    const node = this.node
    this.node = null
    this.onnode(null)
    if (node) await node.close().catch((err) => this.log('close failed', err.message))
    this.log('stop: node closed')
    for (const d of this.dhts.splice(0)) await d.destroy().catch(() => {})
  }

  /**
   * Starts a node for a login flow (create / restore / QR link) when none runs.
   * @param {{ mode?: 'device' | 'memory', deviceName?: string }} o
   */
  begin({ mode = 'device', deviceName } = {}) {
    return this._serial(async () => {
      if (this.node) return this.info()
      if (this.state === 'locked') throw codedError('Session verrouillée', 'LOCKED')
      if (deviceName) this.deviceName = String(deviceName).slice(0, 40)
      if (mode === 'memory') {
        await this._start(null, 'memory')
      } else {
        // A previous, abandoned attempt may have left storage behind: start clean.
        if (!(await this.keys.load())) await this._wipeStorage()
        const dek = await this.keys.create({ mode: 'device', extra: { deviceName: this.deviceName } })
        this.meta = await this.keys.load()
        await this._start(dek, 'device')
      }
      return this.info()
    })
  }

  /** Abandons a login flow: a node without identity is stopped and its storage wiped. */
  cancel() {
    return this._serial(async () => {
      if (!this.node || this.node.me()) return this.info()
      await this._stop()
      await this._wipeAll()
      this._set('idle')
      return this.info()
    })
  }

  unlock(kek) {
    return this._serial(async () => {
      if (this.state !== 'locked') return this.info()
      const dek = await this.keys.unlockWith(kek)
      await this._start(dek, this.meta.mode)
      return this.info()
    })
  }

  /** Locks a passkey-protected session (the node stops, the key is forgotten). */
  lock() {
    return this._serial(async () => {
      if (!this.meta || this.meta.mode !== 'passkey') throw codedError('Verrouillage indisponible sans passkey', 'NO_PASSKEY')
      await this._stop()
      this._set('locked')
      return this.info()
    })
  }

  enablePasskey(kek, { credentialId, prfSalt }) {
    return this._serial(async () => {
      if (this.mode === 'memory') throw codedError('Indisponible en mode ordinateur public', 'MEMORY_MODE')
      await this.keys.enablePasskey(kek, { credentialId, prfSalt })
      this.meta = await this.keys.load()
      this.mode = 'passkey'
      this._emit()
      return this.info()
    })
  }

  disablePasskey(kek) {
    return this._serial(async () => {
      await this.keys.disablePasskey(kek)
      this.meta = await this.keys.load()
      this.mode = 'device'
      this._emit()
      return this.info()
    })
  }

  /**
   * Logout: this device revokes itself in the account's personal base (a `remove-device` entry
   * signed by its device key, so the other devices stop trusting it and rotate the DM box), waits
   * a little for a peer to replicate it, then stops the node and wipes every byte it stored.
   */
  logout({ waitMs = REVOKE_SYNC_MS } = {}) {
    return this._serial(async () => {
      const out = { revoked: false, replicated: false }
      const node = this.node
      if (node && node.secret && node.home) {
        try {
          this.log('logout: revoking this device')
          await node.revokeDevice(node.secret.device.publicKey)
          out.revoked = true
          out.replicated = await this._waitReplicated(node, waitMs)
          this.log('logout: replicated', out.replicated)
        } catch (err) {
          this.log('logout: revoke failed', err.message)
        }
      }
      await this._stop()
      this.log('logout: node stopped')
      await this._wipeAll()
      this.log('logout: wiped')
      this.mode = null
      this.meta = null
      this._set('idle')
      return { ...out, info: this.info() }
    })
  }

  /** True once a connected peer has the personal base's local writer core up to its length. */
  async _waitReplicated(node, ms) {
    const core = node.home && node.home.local
    if (!core) return false
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const peers = core.peers || []
      if (peers.some((p) => p.remoteLength >= core.length || (p.remoteContiguousLength || 0) >= core.length)) return true
      await sleep(200)
    }
    return false
  }

  async _wipeStorage() {
    for (const name of [MAIN_DB, STATS_DB]) await RocksDB.destroy(name, { indexedDB: this.idb }).catch(() => {})
  }

  async _wipeAll() {
    if (this.mode !== 'memory') await this._wipeStorage()
    await this.keys.wipe()
  }

  async close() {
    await this._stop()
    this.keys.close()
  }
}

module.exports = { WebSession, MAIN_DB, STATS_DB, b4a }
