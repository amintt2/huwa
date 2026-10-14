// HyperDHT for the browser node: @huwa/dht-relay (packages/dht-relay, non-custodial) over a
// WebSocket to the Huwa gateway, wrapped so that the WebSocket can die and come back without the
// Hyperswarm on top noticing more than a network change:
//   - servers are re-listened on the new relay connection (same key pair),
//   - 'network-change' makes Hyperswarm re-announce its topics and look its peers up again,
//   - calls made while offline fail fast (queries end empty, mutable ops reject) instead of hanging.
// Every key pair is made and kept here: the gateway gets public keys, signatures and ciphertext.
const { EventEmitter } = require('events')
const { Readable, Duplex } = require('streamx')
const Hyperswarm = require('hyperswarm')
const RelayNode = require('@huwa/dht-relay')
const RelayStream = require('@huwa/dht-relay/ws')

const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 15_000
const STABLE_MS = 30_000

class RelayServer extends EventEmitter {
  constructor(dht, opts, onconnection) {
    super()
    this.dht = dht
    this.opts = opts || {}
    this.keyPair = null
    this.inner = null
    this.listening = false
    this.closed = false
    if (onconnection) this.on('connection', onconnection)
  }

  get publicKey() {
    return this.keyPair && this.keyPair.publicKey
  }

  address() {
    return this.inner ? this.inner.address() : null
  }

  _attach(node, attempt = 0) {
    if (this.closed || !this.keyPair) return Promise.resolve()
    const inner = node.createServer(this.opts)
    inner.on('connection', (conn) => this.emit('connection', conn))
    this.inner = inner
    // The relay refuses while the server of the previous relay connection still closes there
    // (same key pair): try again on the same connection, a bit later.
    return inner.listen(this.keyPair).catch((err) => {
      if (this.closed || node !== this.dht._live()) return
      if (attempt >= 5) return this.dht.log('relay listen failed', err && err.message)
      return new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1))).then(() => this._attach(node, attempt + 1))
    })
  }

  async listen(keyPair = this.dht.defaultKeyPair) {
    this.keyPair = keyPair
    this.listening = true
    const node = this.dht._live()
    // Offline: listened on the next relay connection.
    if (node) await this._attach(node)
    this.emit('listening')
  }

  async refresh() {}
  async suspend() {}
  async resume() {}
  notifyOnline() {}

  async close() {
    if (this.closed) return
    this.closed = true
    this.dht._servers.delete(this)
    if (this.inner) await this.inner.close().catch(() => {})
    this.emit('close')
  }
}

class ReconnectingRelayDHT extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.url  gateway WebSocket, e.g. wss://host/p2p
   * @param {{ publicKey, secretKey }} [o.keyPair]
   * @param {typeof WebSocket} [o.WebSocket]
   * @param {(...a) => void} [o.log]
   * @param {(state: { online: boolean, attempt: number }) => void} [o.onstate]
   */
  constructor({ url, keyPair = RelayNode.keyPair(), WebSocket = globalThis.WebSocket, log = () => {}, onstate = () => {} }) {
    super()
    this.url = url
    this.defaultKeyPair = keyPair
    this.WebSocket = WebSocket
    this.log = log
    this.onstate = onstate
    this.online = false
    this.suspended = false
    this.destroyed = false
    this.randomized = false
    this.firewalled = true
    this.stats = { connects: 0, drops: 0 }
    this._node = null
    this._open = false
    this._servers = new Set()
    this._attempt = 0
    this._timer = null
    this._stableTimer = null
    this._connect()
  }

  _live() {
    return this._node && this._open && !this._node.destroyed ? this._node : null
  }

  ready() {
    if (this._live()) return Promise.resolve()
    return new Promise((resolve) => this.once('network-update', resolve))
  }

  _connect() {
    if (this.destroyed) return
    this.stats.connects++
    let ws
    try {
      ws = new this.WebSocket(this.url)
    } catch (err) {
      this.log('relay socket failed', err.message)
      return this._schedule()
    }
    const node = new RelayNode(new RelayStream(true, ws), { keyPair: this.defaultKeyPair })
    node.on('error', () => {})
    this._node = node
    this._open = false
    const reconnection = this.stats.connects > 1
    node.once('close', () => {
      if (this._node !== node) return
      const was = this._open
      this._open = false
      this._node = null
      if (was) this.stats.drops++
      clearTimeout(this._stableTimer)
      if (this.online) {
        this.online = false
        this.emit('network-update')
        this.onstate({ online: false, attempt: this._attempt })
      }
      this._schedule()
    })
    node.ready().then(
      () => {
        if (this._node !== node || this.destroyed) return
        this._open = true
        this.online = true
        // Only reset the backoff once the link held for a while (a gateway that accepts and
        // drops at once must not be hammered).
        this._stableTimer = setTimeout(() => (this._attempt = 0), STABLE_MS)
        for (const server of this._servers) server._attach(node)
        this.onstate({ online: true, attempt: this._attempt })
        this.emit('network-update')
        // Re-announce and look up again on the new relay connection.
        if (reconnection) this.emit('network-change')
      },
      () => {}
    )
  }

  _schedule() {
    if (this.destroyed || this._timer) return
    const ms = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this._attempt++) * (0.75 + Math.random() * 0.5)
    this._timer = setTimeout(() => {
      this._timer = null
      this._connect()
    }, ms)
  }

  /** Reconnects now (e.g. the browser came back online). */
  kick() {
    if (this.destroyed || this._live()) return
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this._attempt = 0
    if (!this._node) this._connect()
  }

  createServer(opts, onconnection) {
    if (typeof opts === 'function') {
      onconnection = opts
      opts = {}
    }
    const server = new RelayServer(this, opts, onconnection)
    this._servers.add(server)
    return server
  }

  connect(remotePublicKey, opts = {}) {
    const node = this._live()
    if (node) return node.connect(remotePublicKey, { keyPair: opts.keyPair || this.defaultKeyPair })
    return failedStream(remotePublicKey, opts.keyPair || this.defaultKeyPair)
  }

  /**
   * A lookup / announce issued while the relay connection is (re)opening waits for it (up to
   * QUERY_WAIT_MS) instead of ending empty: Hyperswarm and blind-pairing run their first lookup
   * and announce right at start, and only refresh minutes later, so an empty first answer made a
   * fresh browser node undiscoverable (pairing hung with no connection at all).
   */
  _query(name, args) {
    const node = this._live()
    if (node) return node[name](...args)
    if (this.destroyed) return emptyQuery()
    return deferredQuery(this, (n) => n[name](...args))
  }

  lookup(topic) {
    return this._query('lookup', [topic])
  }

  announce(topic, keyPair = this.defaultKeyPair) {
    return this._query('announce', [topic, keyPair])
  }

  lookupAndUnannounce(topic, keyPair = this.defaultKeyPair) {
    return this._query('lookupAndUnannounce', [topic, keyPair])
  }

  async unannounce(topic, keyPair = this.defaultKeyPair) {
    const node = this._live()
    if (node) await node.unannounce(topic, keyPair)
  }

  async mutablePut(keyPair, value, opts) {
    const node = this._live() || (await this._waitLive(5000))
    return node.mutablePut(keyPair, value, opts)
  }

  async mutableGet(publicKey, opts) {
    const node = this._live() || (await this._waitLive(5000))
    return node.mutableGet(publicKey, opts)
  }

  async _waitLive(ms) {
    const ok = await Promise.race([this.ready().then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))])
    const node = ok && this._live()
    if (!node) throw new Error('Passerelle P2P injoignable')
    return node
  }

  async suspend() {
    this.suspended = true
  }

  async resume() {
    this.suspended = false
    this.kick()
  }

  async destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.online = false
    clearTimeout(this._timer)
    clearTimeout(this._stableTimer)
    for (const s of [...this._servers]) await s.close().catch(() => {})
    if (this._node) await this._node.destroy({ force: true }).catch(() => {})
    this._node = null
  }

  static keyPair(seed) {
    return RelayNode.keyPair(seed)
  }
}

const QUERY_WAIT_MS = 15_000

function deferredQuery(dht, start) {
  let inner = null
  let done = false
  const q = new Readable({
    destroy(cb) {
      cleanup()
      if (inner) inner.destroy()
      cb(null)
    }
  })
  q.closestNodes = []
  q.closestReplies = []
  const end = () => {
    if (done) return
    done = true
    cleanup()
    q.push(null)
  }
  const onUpdate = () => {
    const node = dht._live()
    if (!node || inner || q.destroyed) return
    cleanup()
    inner = start(node)
    inner.on('data', (d) => q.push(d))
    inner.on('end', end)
    inner.on('error', end)
    inner.on('close', end)
  }
  const timer = setTimeout(end, QUERY_WAIT_MS)
  function cleanup() {
    clearTimeout(timer)
    dht.off('network-update', onUpdate)
  }
  dht.on('network-update', onUpdate)
  q.finished = () => {
    q.resume()
    return new Promise((resolve) => (q.destroyed ? resolve() : q.once('close', resolve)))
  }
  return q
}

function emptyQuery() {
  const q = new Readable()
  q.push(null)
  q.closestNodes = []
  q.closestReplies = []
  q.finished = () => {
    q.resume()
    return new Promise((resolve) => (q.destroyed ? resolve() : q.once('close', resolve)))
  }
  return q
}

function failedStream(remotePublicKey, keyPair) {
  const s = new Duplex()
  s.remotePublicKey = remotePublicKey
  s.publicKey = keyPair.publicKey
  s.rawStream = null
  queueMicrotask(() => s.destroy(new Error('Passerelle P2P injoignable')))
  return s
}

/**
 * HuwaNode `swarmFactory` for the browser: one relay connection (and DHT) per swarm.
 * @param {object} o  ReconnectingRelayDHT options, plus `dhts` (array collecting the DHTs made)
 */
function createRelaySwarmFactory({ dhts = [], ...o }) {
  return function swarmFactory(opts = {}) {
    const keyPair = opts.keyPair || RelayNode.keyPair()
    const dht = new ReconnectingRelayDHT({ ...o, keyPair })
    dhts.push(dht)
    const swarm = new Hyperswarm({ keyPair, dht })
    return swarm
  }
}

module.exports = { ReconnectingRelayDHT, createRelaySwarmFactory }
