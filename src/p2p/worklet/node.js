// HuwaNode: every P2P method of src/p2p/contract.ts, on top of Corestore / Autobase / Hyperswarm.
// Environment agnostic (Bare worklet in the app, Node in tests and in the desktop test peer).
const Corestore = require('corestore')
const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const Hyperswarm = require('hyperswarm')
const Protomux = require('protomux')
const ProtomuxWakeup = require('protomux-wakeup')
const BlindPairing = require('blind-pairing')
const IdentityKey = require('keet-identity-key')
const bip39 = require('bip39-mnemonic')
const crypto = require('hypercore-crypto')
const c = require('compact-encoding')
const b4a = require('b4a')

const { hash, toHex, fromHex, isKey, seriesIdOfTarget, fingerprint, canon } = require('./util')
const schema = require('./schema')
const pow = require('./pow')
const seal = require('./seal')
const { makeAuth, verifyDeviceProof } = require('./auth')
const { commentId, createRoomApply, createHomeApply, createDmApply, createMapApply, createFlagApply, rateOk, mapKey, flagKey, MAP_RATE, FLAG_RATE } = require('./apply')
const stats = require('./stats')
const { RelayMirror, homeReferrer } = require('./relay')

const ROOM_IDLE_MS = 60_000
const LOOKUP_MS = 6_000
const PAIRING_TTL_MS = 10 * 60_000
const MAX_COMMENTS = 1000
// A hello hinting a DM opens the conversation base on probation only: it becomes a conversation
// (persisted, reopened at every start) once a message from that peer actually decrypts.
const DM_PROBE_MS = 90_000
const MAX_DM_PROBES = 8
const DM_PROBE_BACKOFF_MS = 10 * 60_000
/** Comments dated further in the future are not listed (yet): they would pin to the end. */
const FUTURE_SKEW_MS = 10 * 60_000
// Restore: how long the devices of the account get to answer (pointer core or hello).
const RESTORE_LOOKUP_MS = 15_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const noop = () => {}
/** Background timer that never keeps the process alive (Node tests). */
function later(fn, ms) {
  const t = setTimeout(fn, ms)
  if (t && typeof t.unref === 'function') t.unref()
  return t
}

function withTimeout(promise, ms, fallback) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

// Protocol version of rooms and DM bases: bump it whenever `apply` rules change incompatibly
// (a peer on older rules would reject new nodes and never bind their writers).
// v3: comment edit/delete entries (older peers would ignore them and show stale text).
const PROTOCOL = 'v3'
const workBaseKey = (work) => crypto.keyPair(hash('huwa/work/' + PROTOCOL + '/' + work)).publicKey
const dmPair = (a, b) => [a, b].sort()
const dmBaseKey = (pair) => crypto.keyPair(hash('huwa/dm/' + PROTOCOL + '/' + pair.join(':'))).publicKey
const idTopic = (identity) => hash('huwa/id/v1/' + identity)
// Community stats rooms have their own version (separate bases, untouched by PROTOCOL bumps).
const statsBaseKey = (month) => crypto.keyPair(hash('huwa/stats/v' + stats.STATS_VERSION + '/' + month)).publicKey
// Mapping rooms (episode ↔ chapter corrections) are new bases with their own version: older peers
// never open them, so no PROTOCOL bump (comment rooms and DMs are untouched).
const MAP_VERSION = 'v1'
const mapBaseKey = (room) => crypto.keyPair(hash('huwa/map/' + MAP_VERSION + '/' + room)).publicKey
const MAX_MAPPING = 5000
// Flag rooms (community reports of comments) are new bases too: no PROTOCOL bump, older peers
// never open them and keep seeing every comment.
const FLAG_VERSION = 'v1'
const flagBaseKey = (work) => crypto.keyPair(hash('huwa/flag/' + FLAG_VERSION + '/' + work)).publicKey
const MAX_FLAGS = 5000
/** The stats swarm and bases close after this long without use. */
const STATS_IDLE_MS = 5 * 60_000
const MAX_STATS_READ = 5000

function viewOf(store) {
  return new Hyperbee(store.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false })
}

async function valueOf(bee, key) {
  const node = await bee.get(key)
  return node ? node.value : null
}

async function rangeValues(bee, prefix, opts = {}) {
  const out = []
  for await (const e of bee.createReadStream({ gt: prefix, lt: prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1), ...opts })) {
    out.push(e)
  }
  return out
}

class HuwaNode {
  /**
   * @param {object} opts
   * @param {string} opts.storage  Corestore directory
   * @param {Array} [opts.bootstrap]  DHT bootstrap nodes (`host:port` or `{host, port}`)
   * @param {string} [opts.deviceName]
   * @param {(ev: object) => void} [opts.onevent]  status / me / subscription pushes
   * @param {{ enabled?: boolean, keys?: string[] }} [opts.relays]  Huwa relays (see relay.js)
   */
  constructor({ storage, bootstrap, deviceName = 'appareil', onevent = noop, log = noop, restoreLookupMs = RESTORE_LOOKUP_MS, relays = null }) {
    this.storage = storage
    this.restoreLookupMs = restoreLookupMs
    this.bootstrap = bootstrap && bootstrap.length ? bootstrap : undefined
    this.deviceName = deviceName
    this.onevent = onevent
    this.log = log

    this.store = new Corestore(storage)
    this.wakeup = new ProtomuxWakeup()
    this.swarm = null
    this.local = new Hyperbee(this.store.get({ name: 'huwa-local' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })

    this.secret = null // this device's identity material (never leaves the worklet)
    this.home = null // my personal Autobase
    this.meProfile = undefined
    this.rooms = new Map() // work -> { base, refs, timer, discovery }
    this.mapRooms = new Map() // manhwa room -> { base, refs, timer, discovery }
    this.flagRooms = new Map() // work -> { base, refs, timer, discovery }
    this.homes = new Map() // identity -> { base, discovery } (other people's personal bases)
    this.dms = new Map() // peer -> { base, discovery }
    this.peers = new Map() // identity -> { home, box, name }
    this.channels = new Set()
    this.dmHints = new Set()
    this.subs = new Map()
    this.pairing = null
    this.pairingMembers = new Set()
    this.state = 'starting'
    this.suspended = false
    this.closed = false
    this._statusTimer = null
    // Community stats (opt-in): separate Corestore + swarm, opened on demand (see _statsNet).
    this.statsStore = null
    this.statsLocal = null
    this.statsSwarm = null
    this.statsWakeup = null
    this.statsBases = new Map() // month -> { id, base, discovery }
    this._statsTimer = null
    this.relay = new RelayMirror({ log })
    this._relayCfg = relays || { enabled: false, keys: [] }
  }

  // ---- lifecycle ----------------------------------------------------------

  async ready() {
    const t0 = Date.now()
    await this.store.ready()
    await this.local.ready()
    const tStore = Date.now()
    this.swarm = new Hyperswarm({ bootstrap: this.bootstrap })
    this.swarm.on('connection', (conn, info) => this._onconnection(conn, info))
    this.swarm.on('update', () => this._emitStatus())
    this.relay.attach({ dht: this.swarm.dht, store: this.store, wakeup: this.wakeup })
    this.relay.configure(this._relayCfg)

    for (const e of await rangeValues(this.local, 'peer/')) this.peers.set(e.key.slice(5), e.value)

    this.secret = await valueOf(this.local, 'secret')
    if (this.secret) await this._openMyself()

    this.state = 'ready'
    this._emitStatus()
    this.log('ready: corestore', tStore - t0, 'ms, identity/base perso', Date.now() - tStore, 'ms')
  }

  status() {
    const peers = this.swarm ? this.swarm.connections.size : 0
    if (this.state === 'ready' && this.suspended) return { state: 'offline', peers }
    return { state: this.state, peers }
  }

  _emitStatus() {
    if (this._statusTimer) return
    this._statusTimer = setTimeout(() => {
      this._statusTimer = null
      this.onevent({ ev: 'status', data: this.status() })
    }, 50)
  }

  async suspend() {
    if (this.suspended || this.closed) return
    this.suspended = true
    this._emitStatus()
    if (this.pairing) await this.pairing.suspend().catch(noop)
    await this.relay.suspend()
    if (this.swarm) await this.swarm.suspend().catch(noop)
    await this._closeStats().catch(noop)
    await this.store.suspend().catch(noop)
  }

  async resume() {
    if (!this.suspended || this.closed) return
    this.suspended = false
    await this.store.resume()
    if (this.swarm) await this.swarm.resume().catch(noop)
    await this.relay.resume()
    if (this.pairing) this.pairing.resume()
    this._emitStatus()
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const sub of this.subs.values()) sub()
    this.subs.clear()
    if (this._statusTimer) clearTimeout(this._statusTimer)
    for (const room of [...this.rooms.values(), ...this.mapRooms.values(), ...this.flagRooms.values()]) if (room.timer) clearTimeout(room.timer)
    for (const member of this.pairingMembers) await member.close().catch(noop)
    if (this.pairing) await this.pairing.close().catch(noop)
    await this.relay.close()
    if (this.swarm) await this.swarm.destroy().catch(noop)
    await this._closeStats().catch(noop)
    if (this.statsStore) await this.statsStore.close().catch(noop)
    const bases = [...this.rooms.values(), ...this.mapRooms.values(), ...this.flagRooms.values(), ...this.homes.values(), ...this.dms.values()].map((r) => r.base)
    if (this.home) bases.push(this.home)
    await Promise.all(bases.map((b) => b.close().catch(noop)))
    await this.store.close()
  }

  // ---- swarm / hello protocol ----------------------------------------------

  _join(topic, { server = true, client = true } = {}) {
    if (!this.swarm) return null
    const discovery = this.swarm.join(topic, { server, client })
    // Two peers joining at the same moment can miss each other (each lookup runs before the
    // other's announce lands) and Hyperswarm only refreshes every few minutes: look again soon.
    if (client) {
      for (const ms of [3000, 10000, 30000]) {
        later(() => {
          if (!this.closed && !this.suspended && !discovery.destroyed) discovery.refresh().catch(noop)
        }, ms)
      }
    }
    return discovery
  }

  _onconnection(conn) {
    this.log('connection', conn.rawStream ? conn.rawStream.remoteHost + ':' + conn.rawStream.remotePort : '')
    conn.on('error', (err) => this.log('connection error', err.message))
    const stream = this.store.replicate(conn)
    this.wakeup.addStream(stream)
    const mux = Protomux.from(conn)
    const channel = mux.createChannel({
      protocol: 'huwa/hello/v1',
      onopen: () => this._sendHello(channel, conn),
      onclose: () => this.channels.delete(channel)
    })
    if (channel) {
      channel.hello = channel.addMessage({
        encoding: c.json,
        onmessage: (m) => this._onhello(m, conn).catch((err) => this.log('hello error', err.message))
      })
      channel.conn = conn
      this.channels.add(channel)
      channel.open()
    }
    conn.on('close', () => {
      this.log('connection closed')
      this._emitStatus()
    })
    this._emitStatus()
  }

  _helloMessage(conn) {
    const s = this.secret
    if (!s) return null
    const proof = IdentityKey.attestData(conn.publicKey, this._device(), fromHex(s.proof))
    return { v: 1, id: s.identity, home: s.home, box: toHex(this._box().publicKey), proof: toHex(proof), dm: [...this.dmHints].slice(0, 64) }
  }

  _sendHello(channel, conn) {
    const m = this._helloMessage(conn)
    if (m && channel.hello) channel.hello.send(m)
  }

  _broadcastHello() {
    for (const ch of this.channels) this._sendHello(ch, ch.conn)
  }

  async _onhello(m, conn) {
    if (!schema.hello(m)) return
    let info = null
    try {
      info = IdentityKey.verify(fromHex(m.proof), conn.remotePublicKey)
    } catch {
      info = null
    }
    if (!info || toHex(info.identityPublicKey) !== m.id) return
    if (this.secret && m.id === this.secret.identity) return
    // A device revoked in its owner's personal base is not listened to (it still holds a valid proof).
    const peerHome = this.homes.get(m.id)
    if (peerHome && info.devicePublicKey && (await valueOf(peerHome.base.view, 'rev/' + toHex(info.devicePublicKey)))) return
    const prev = this.peers.get(m.id) || {}
    // The box published in the personal base wins over the one a device presents (a revoked device
    // would present the pre-rotation box it still holds), and a known personal base is kept.
    const box = prev.boxSrc === 'profile' && prev.box ? prev.box : m.box
    const home = prev.home || m.home
    if (prev.home !== home || prev.box !== box) {
      const next = { ...prev, home, box }
      this.peers.set(m.id, next)
      await this.local.put('peer/' + m.id, next)
    }
    if (this.secret && m.dm.includes(this.secret.identity)) {
      await this._probeDm(m.id)
    }
  }

  /** Looks for a message from `peer` without committing to a conversation (see DM_PROBE_MS). */
  async _probeDm(peer) {
    if (await valueOf(this.local, 'conv/' + peer)) {
      if (!this.dms.has(peer)) await this._openDm(peer)
      return
    }
    this._probes = this._probes || new Map()
    if (this.dms.has(peer) || this._probes.has(peer)) return
    const now = Date.now()
    for (const [k, at] of this._probes) if (at.done && now - at.done > DM_PROBE_BACKOFF_MS) this._probes.delete(k)
    if ([...this._probes.values()].filter((p) => !p.done).length >= MAX_DM_PROBES) return
    if (this.home && (await valueOf(this.home.view, 'blk/' + peer))) return
    const probe = { done: 0 }
    this._probes.set(peer, probe)
    later(() => this._endProbe(peer, probe).catch(noop), DM_PROBE_MS)
    await this._openDm(peer)
    await this._onDmUpdate(peer)
  }

  async _endProbe(peer, probe) {
    probe.done = Date.now()
    if (this.closed || (await valueOf(this.local, 'conv/' + peer))) return
    const entry = this.dms.get(peer)
    if (!entry) return
    this.dms.delete(peer)
    if (entry.discovery) entry.discovery.destroy().catch(noop)
    await entry.base.close().catch(noop)
  }

  async _lookup(identity) {
    const known = this.peers.get(identity)
    if (known && known.home) return known
    const discovery = this._join(idTopic(identity), { server: false, client: true })
    try {
      const deadline = Date.now() + LOOKUP_MS
      while (Date.now() < deadline) {
        const p = this.peers.get(identity)
        if (p && p.home) return p
        await sleep(200)
      }
      return this.peers.get(identity) || null
    } finally {
      // Found or not, the topic is left (the connection, if any, stays).
      if (discovery) discovery.destroy().catch(noop)
    }
  }

  // ---- identity (phase 2) ---------------------------------------------------

  _device() {
    return { publicKey: fromHex(this.secret.device.publicKey), secretKey: fromHex(this.secret.device.secretKey) }
  }

  _box() {
    if (!this._boxKeyPair) this._boxKeyPair = seal.boxKeyPair(fromHex(this.secret.boxSeed))
    return this._boxKeyPair
  }

  /** Current box first, then the ones replaced by a rotation (older messages are sealed to them). */
  _boxes() {
    if (!this._oldBoxKeyPairs) this._oldBoxKeyPairs = (this.secret.oldBoxSeeds || []).map((seed) => seal.boxKeyPair(fromHex(seed)))
    return [this._box(), ...this._oldBoxKeyPairs]
  }

  _requireIdentity() {
    if (!this.secret || !this.home) throw new Error("Pas encore d'identité sur cet appareil")
  }

  _openHomeBase(identity, key, ns) {
    return new Autobase(this.store.namespace(ns), key, {
      optimistic: true,
      valueEncoding: 'json',
      wakeup: this.wakeup,
      open: viewOf,
      apply: createHomeApply(identity)
    })
  }

  async _openMyself() {
    const s = this.secret
    this.home = this._openHomeBase(s.identity, s.home ? fromHex(s.home) : null, 'home')
    await this.home.ready()
    this.home.on('update', () => this._onHomeUpdate())
    this._join(this.home.discoveryKey)
    this.relay.mirrorBase(this.home, 'own')
    this._join(idTopic(s.identity), { server: true, client: false })
    if (s.pointer) {
      this.pointer = this.store.get({ key: fromHex(s.pointer) })
      await this.pointer.ready()
      this._join(this.pointer.discoveryKey, { server: true, client: false })
      this.relay.mirrorCore(this.pointer, { referrer: homeReferrer(this.home) })
    }
    for (const e of await rangeValues(this.local, 'conv/')) this._openDm(e.key.slice(5)).catch(noop)
    for (const e of await rangeValues(this.home.view, 'sub/')) this._openPeerHome(e.key.slice(4)).catch(noop)
    await this._onHomeUpdate()
  }

  async _onHomeUpdate() {
    await this._syncBox().catch((err) => this.log('box sync', err.message))
    const p = await valueOf(this.home.view, 'profile')
    const next = p ? this._profile(this.secret.identity, p) : undefined
    if (canon(next || null) !== canon(this.meProfile || null)) {
      this.meProfile = next
      this.onevent({ ev: 'me', data: next || null })
    }
    this._notify('labels')
    const revs = (await rangeValues(this.home.view, 'rev/')).length
    if (revs !== this._revCount) {
      const first = this._revCount === undefined
      this._revCount = revs
      if (revs && !first) this._propagateAll().catch(noop)
    }
  }

  // ---- device revocation: DM box rotation, revocations in shared bases ---------

  /**
   * Adopts the box published in my personal base when it is not mine any more (rotated by another
   * device), and re-shares the current box with devices that joined after the last rotation.
   */
  async _syncBox() {
    if (!this.secret || !this.home || this._boxBusy) return
    const p = await valueOf(this.home.view, 'profile')
    if (!p || !p.box) return
    const entries = await rangeValues(this.home.view, 'box/')
    if (!entries.length) return
    this._boxBusy = true
    try {
      const me = this.secret.device.publicKey
      if (p.box !== toHex(this._box().publicKey)) {
        const mine = seal.signToBoxKeyPair(this._device())
        const seeds = new Map()
        for (const e of entries) {
          const tries = [[e.value.seeds[me], mine]]
          if (this._rootBox) tries.push([e.value.seeds.root, this._rootBox])
          for (const [sealed, kp] of tries) {
            const seed = sealed ? seal.open(fromHex(sealed), kp) : null
            if (seed && seed.byteLength === 32 && toHex(seal.boxKeyPair(seed).publicKey) === e.value.box) seeds.set(e.value.box, toHex(seed))
          }
        }
        const current = seeds.get(p.box)
        if (!current) return // not shared with this device yet
        const old = [this.secret.boxSeed, ...(this.secret.oldBoxSeeds || []), ...seeds.values()]
        const oldBoxSeeds = [...new Set(old)].filter((x) => x !== current).slice(0, 16)
        await this._saveSecret({ ...this.secret, boxSeed: current, oldBoxSeeds })
        this._broadcastHello()
        return
      }
      // I hold the current box: share it with the devices missing from the last rotation.
      const last = entries[entries.length - 1].value
      if (last.box !== p.box) return
      const devices = await this._boxDevices(p)
      if (devices.every((d) => last.seeds[d])) return
      await this._appendHome('box', this._boxBody(fromHex(this.secret.boxSeed), devices, p.rot))
    } finally {
      this._boxBusy = false
    }
  }

  /** Remaining (not revoked) devices a box seed is sealed to, within the node size bound. */
  async _boxDevices(p) {
    const devices = (await rangeValues(this.home.view, 'dev/')).filter((e) => !e.value.revoked).map((e) => e.key.slice(4))
    const me = this.secret.device.publicKey
    const others = devices.filter((d) => d !== me)
    return (devices.includes(me) ? [me, ...others] : others).slice(0, p.rot ? 23 : 24)
  }

  _boxBody(seed, devices, rot) {
    const seeds = {}
    for (const d of devices) seeds[d] = toHex(seal.seal(seed, seal.signToBoxPublicKey(fromHex(d))))
    if (rot) seeds.root = toHex(seal.seal(seed, fromHex(rot)))
    return { box: toHex(seal.boxKeyPair(seed).publicKey), seeds }
  }

  /** New DM box after a revocation: the revoked device cannot open messages sealed from now on. */
  async _rotateBox() {
    const p = await valueOf(this.home.view, 'profile')
    if (!p) return
    const devices = await this._boxDevices(p)
    if (!devices.includes(this.secret.device.publicKey)) return
    const seed = crypto.randomBytes(32)
    await this._appendHome('box', this._boxBody(seed, devices, p.rot))
    await this._onHomeUpdate()
  }

  /** Publishes the revocations of my personal base in a shared base where my writer is bound. */
  async _propagateRevocations(base, room) {
    if (!this.secret || !this.home || base.closed) return
    const revs = await rangeValues(this.home.view, 'rev/')
    if (!revs.length || revs.some((e) => e.key.slice(4) === this.secret.device.publicKey)) return
    await base.ready()
    // Only once my writer is bound there: older peers would not bind a writer from a `revoke`.
    if (!(await valueOf(base.view, 'w/' + toHex(base.local.key)))) return
    for (const e of revs) {
      const dev = e.key.slice(4)
      if (await valueOf(base.view, 'rv/' + this.secret.identity + '/' + dev)) continue
      await this._append(base, 'revoke', room, { device: dev }, { nonceBits: room === 'dm' ? 0 : pow.DIFFICULTY.like })
    }
  }

  async _propagateAll() {
    for (const [work, room] of this.rooms) await this._propagateRevocations(room.base, 'work:' + work).catch(noop)
    for (const e of await rangeValues(this.local, 'conv/')) {
      const base = await this._openDm(e.key.slice(5)).catch(() => null)
      if (base) await this._propagateRevocations(base, 'dm').catch(noop)
    }
  }

  _profile(key, p) {
    return { key, name: p.name, bio: p.bio, avatar: p.avatar, createdAt: p.createdAt, fingerprint: fingerprint(key) }
  }

  async _authFor(base) {
    const w = toHex(base.local.key)
    if (await valueOf(base.view, 'w/' + w)) return undefined
    return makeAuth({ device: this._device(), proof: fromHex(this.secret.proof), writerKey: base.local.key, homeKey: fromHex(this.secret.home) })
  }

  async _append(base, t, room, body, { nonceBits = 0 } = {}) {
    await base.ready()
    const value = { v: 1, t, room, ts: Date.now(), body }
    const auth = await this._authFor(base)
    if (auth) value.auth = auth
    if (nonceBits > 0 || ['comment', 'like', 'vouch', 'dm'].includes(t)) {
      value.nonce = await pow.solve(pow.powPayload(value, toHex(base.local.key)), nonceBits)
    }
    await base.append(value, { optimistic: !base.writable })
    await base.update()
    return value
  }

  async _appendHome(t, body) {
    return this._append(this.home, t, 'home', body)
  }

  async _saveSecret(s) {
    this.secret = s
    this._boxKeyPair = null
    this._oldBoxKeyPairs = null
    await this.local.put('secret', s)
  }

  async _deriveRoot(mnemonic) {
    const ik = await IdentityKey.from({ mnemonic })
    const out = {
      identity: toHex(ik.identityPublicKey),
      boxSeed: toHex(ik.getEncryptionKey(b4a.from('huwa/box/v1'))),
      // Only its public half is published: rotated box seeds are also sealed to it, so a restore
      // from the phrase recovers them while a revoked device (no root) cannot.
      rot: seal.boxKeyPair(ik.getEncryptionKey(b4a.from('huwa/box-rotate/v1'))),
      pointer: { publicKey: b4a.from(ik.profileDiscoveryKeyPair.publicKey), secretKey: b4a.from(ik.profileDiscoveryKeyPair.secretKey) },
      bootstrap: (device) => ik.bootstrap(device)
    }
    return { ik, out }
  }

  async createIdentity(name) {
    if (this.secret) throw new Error('Une identité existe déjà sur cet appareil')
    if (typeof name !== 'string' || !name.trim() || name.length > schema.LIMITS.name) throw new Error('Pseudo invalide')
    const mnemonic = IdentityKey.generateMnemonic()
    const profile = await this._createFromMnemonic(mnemonic, name.trim(), null)
    return { profile, phrase: mnemonic.split(' ') }
  }

  async _createFromMnemonic(mnemonic, name, existingHome) {
    const { ik, out } = await this._deriveRoot(mnemonic)
    const device = crypto.keyPair()
    const proof = await out.bootstrap(device.publicKey)
    ik.clear() // the root secret does not stay on the device
    this._rootBox = out.rot // memory only, for this session (see _syncBox)

    const pointer = this.store.get({ keyPair: out.pointer })
    await pointer.ready()

    await this._saveSecret({
      identity: out.identity,
      device: { publicKey: toHex(device.publicKey), secretKey: toHex(device.secretKey) },
      proof: toHex(proof),
      boxSeed: out.boxSeed,
      home: existingHome,
      pointer: toHex(pointer.key),
      deviceName: this.deviceName,
      phraseVerified: false,
      createdAt: Date.now()
    })

    if (existingHome) {
      await this._openMyself()
      await this._appendHome('bind', {})
      const p = await this._waitFor(async () => valueOf(this.home.view, 'profile'), 10_000)
      if (p && !p.rot) await this._appendHome('profile', { rot: toHex(out.rot.publicKey) }).catch(noop)
    } else {
      this.home = this._openHomeBase(out.identity, null, 'home')
      await this.home.ready()
      await this._saveSecret({ ...this.secret, home: toHex(this.home.key) })
      await this.home.close()
      await this._openMyself()
      await this._appendHome('inception', { name, box: toHex(this._box().publicKey), device: this.deviceName })
      await this._appendHome('profile', { rot: toHex(out.rot.publicKey) })
      await pointer.append(b4a.from(JSON.stringify({ home: this.secret.home })))
    }
    await pointer.close()
    await this._onHomeUpdate()
    if (!this.meProfile) {
      // Restored from phrase while the other devices are offline: profile arrives later.
      return this._profile(out.identity, { name: name || 'moi', createdAt: Date.now() })
    }
    return this.meProfile
  }

  async _waitFor(fn, ms) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const v = await fn()
      if (v) return v
      await sleep(250)
    }
    return null
  }

  /**
   * Joins the existing account of `phrase`. Never creates a personal base: when no device of the
   * account answers in time, fails with code RESTORE_NOT_FOUND and leaves this device untouched
   * (a new base appended to the root-owned pointer would make the real one unreachable forever).
   */
  async restoreIdentity(phrase) {
    if (this.secret) throw new Error('Une identité existe déjà sur cet appareil')
    if (!Array.isArray(phrase) || phrase.length < 12 || phrase.length > 24 || !phrase.every((w) => typeof w === 'string')) {
      throw new Error('Phrase invalide')
    }
    const mnemonic = phrase.map((w) => w.trim().toLowerCase()).join(' ')
    if (!bip39.validateMnemonic(mnemonic)) throw new Error('Phrase invalide')

    const { ik, out } = await this._deriveRoot(mnemonic)
    ik.clear()
    // Find the personal base through the pointer core owned by the root's discovery key.
    const pointer = this.store.get({ keyPair: out.pointer })
    await pointer.ready()
    // Client only: two devices restoring at once must not "find" each other's empty pointer.
    const discovery = this._join(pointer.discoveryKey, { server: false, client: true })
    // Devices linked by QR do not hold the pointer, but every device of the account announces on
    // the identity topic and presents its personal base in its (identity-signed) hello.
    const idDiscovery = this._join(idTopic(out.identity), { server: false, client: true })
    // Every device of the account may be gone (wiped phone): the Huwa relays keep the pointer.
    this.relay.fetch(pointer, this.restoreLookupMs).catch(noop)
    const fromPointer = async () => {
      await pointer.update({ wait: false }).catch(noop)
      if (pointer.length === 0) return null
      const last = await pointer.get(pointer.length - 1, { timeout: 2000 }).catch(() => null)
      if (!last) return null
      try {
        const v = JSON.parse(b4a.toString(last))
        return isKey(v.home) ? v.home : null
      } catch {
        return null
      }
    }
    const fromHello = () => {
      const p = this.peers.get(out.identity)
      return p && isKey(p.home) ? p.home : null
    }
    let found = null
    try {
      // The root-signed pointer wins; a hello only counts after a short grace period for it.
      const grace = Date.now() + Math.min(4000, this.restoreLookupMs / 3)
      found = await this._waitFor(async () => (await fromPointer()) || (Date.now() > grace ? fromHello() : null), this.restoreLookupMs)
    } finally {
      if (discovery) await discovery.destroy().catch(noop)
      if (idDiscovery) await idDiscovery.destroy().catch(noop)
      await pointer.close().catch(noop)
      // The hello of my own devices was stored as a peer: not one.
      if (this.peers.has(out.identity)) {
        this.peers.delete(out.identity)
        await this.local.del('peer/' + out.identity).catch(noop)
      }
    }
    if (!found) {
      const err = new Error("Aucun de tes appareils n'a répondu. Réessaie quand un appareil connecté à ton compte est en ligne (app ouverte).")
      err.code = 'RESTORE_NOT_FOUND'
      throw err
    }
    return this._createFromMnemonic(mnemonic, null, found)
  }

  me() {
    return this.meProfile
  }

  async updateProfile(patch) {
    this._requireIdentity()
    const body = {}
    for (const k of ['name', 'bio', 'avatar']) if (typeof patch[k] === 'string') body[k] = k === 'name' ? patch[k].trim() : patch[k]
    if (!Object.keys(body).length) return this.meProfile
    if (!schema.homeNode({ v: 1, t: 'profile', room: 'home', ts: Date.now(), body })) throw new Error('Profil invalide')
    await this._appendHome('profile', body)
    await this._onHomeUpdate()
    return this.meProfile
  }

  async _openPeerHome(identity, homeHex) {
    let entry = this.homes.get(identity)
    if (entry) return entry.base
    const info = homeHex ? { home: homeHex } : await this._lookup(identity)
    if (!info || !info.home) return null
    const base = this._openHomeBase(identity, fromHex(info.home), 'home/' + identity)
    await base.ready()
    base.on('update', () => {
      this._notify('labels')
      this._refreshPeerName(identity, base).catch(noop)
    })
    entry = { base, discovery: this._join(base.discoveryKey) }
    this.homes.set(identity, entry)
    return base
  }

  async _refreshPeerName(identity, base) {
    const p = await valueOf(base.view, 'profile')
    if (!p) return null
    const prev = this.peers.get(identity) || {}
    if (prev.name !== p.name || prev.box !== p.box || (p.box && prev.boxSrc !== 'profile')) {
      const next = { ...prev, name: p.name, box: p.box || prev.box, boxSrc: p.box ? 'profile' : prev.boxSrc, home: prev.home || toHex(base.key) }
      this.peers.set(identity, next)
      await this.local.put('peer/' + identity, next)
      this._notify('conversations')
    }
    return p
  }

  async getProfile(key) {
    if (!isKey(key)) return undefined
    if (this.secret && key === this.secret.identity) return this.meProfile
    const base = await this._openPeerHome(key)
    if (!base) return undefined
    await base.update().catch(noop)
    const p = await this._waitFor(() => this._refreshPeerName(key, base), 4000)
    return p ? this._profile(key, p) : undefined
  }

  async backupState() {
    const devices = this.home ? (await this.devices()).filter((d) => !d.revoked).length : 0
    return { cloud: false, phraseVerified: !!(this.secret && this.secret.phraseVerified), devices }
  }

  async markPhraseVerified() {
    this._requireIdentity()
    await this._saveSecret({ ...this.secret, phraseVerified: true })
  }

  async devices() {
    this._requireIdentity()
    const me = this.secret.device.publicKey
    return (await rangeValues(this.home.view, 'dev/')).map((e) => {
      const key = e.key.slice(4)
      return { key, name: e.value.name, addedAt: e.value.addedAt, current: key === me, revoked: e.value.revoked || undefined }
    })
  }

  _pairing() {
    if (!this.pairing) this.pairing = new BlindPairing(this.swarm, { poll: 5000 })
    return this.pairing
  }

  async pairingInvite() {
    this._requireIdentity()
    const homeKey = fromHex(this.secret.home)
    const { invite, publicKey, discoveryKey, seed } = BlindPairing.createInvite(homeKey)
    const inviteKeyPair = crypto.keyPair(seed)
    const member = this._pairing().addMember({
      discoveryKey,
      onadd: async (candidate) => {
        const userData = candidate.open(publicKey)
        let req = null
        try {
          req = JSON.parse(b4a.toString(userData))
        } catch {
          req = null
        }
        if (!req || !isKey(req.device) || typeof req.name !== 'string' || req.name.length > schema.LIMITS.name) {
          candidate.deny()
          return
        }
        const proof = IdentityKey.attestDevice(fromHex(req.device), this._device(), fromHex(this.secret.proof))
        await this._appendHome('add-device', { device: req.device, name: req.name || 'appareil' })
        candidate.confirm({
          key: homeKey,
          encryptionKey: fromHex(this.secret.boxSeed),
          additional: { data: proof, signature: crypto.sign(proof, inviteKeyPair.secretKey) }
        })
        this.onevent({ ev: 'devices' })
        later(() => member.close().catch(noop), 5000)
      }
    })
    this.pairingMembers.add(member)
    later(() => {
      this.pairingMembers.delete(member)
      member.close().catch(noop)
    }, PAIRING_TTL_MS)
    return 'huwa-pair:' + toHex(invite)
  }

  async acceptPairing(inviteStr) {
    if (this.secret) throw new Error('Une identité existe déjà sur cet appareil')
    const m = /^huwa-pair:([0-9a-f]{2,1024})$/.exec(String(inviteStr).trim())
    if (!m) throw new Error('Invitation invalide')
    const invite = fromHex(m[1])
    const device = crypto.keyPair()
    const userData = b4a.from(JSON.stringify({ device: toHex(device.publicKey), name: this.deviceName }))
    const candidate = this._pairing().addCandidate({ invite, userData })
    const paired = await withTimeout(candidate.pairing, 120_000, null)
    if (!paired) {
      await candidate.close().catch(noop)
      throw new Error("L'appairage a expiré")
    }
    const info = paired.data ? verifyDeviceProof(paired.data, device.publicKey) : null
    if (!info || !paired.encryptionKey || paired.encryptionKey.byteLength !== 32) throw new Error('Réponse d’appairage invalide')
    await this._saveSecret({
      identity: info.identity,
      device: { publicKey: toHex(device.publicKey), secretKey: toHex(device.secretKey) },
      proof: toHex(paired.data),
      boxSeed: toHex(paired.encryptionKey),
      home: toHex(paired.key),
      pointer: null,
      deviceName: this.deviceName,
      phraseVerified: true,
      createdAt: Date.now()
    })
    await this._openMyself()
    await this._appendHome('bind', {})
    await this._waitFor(async () => valueOf(this.home.view, 'profile'), 15_000)
    await this._onHomeUpdate()
    return this.meProfile || this._profile(info.identity, { name: 'moi', createdAt: Date.now() })
  }

  async revokeDevice(deviceKey) {
    this._requireIdentity()
    if (!isKey(deviceKey)) throw new Error('Appareil inconnu')
    await this._appendHome('remove-device', { device: deviceKey })
    // The revoked device keeps the DM box seed: rotate it, and refuse its writes in DMs and rooms.
    await this._rotateBox().catch((err) => this.log('box rotation', err.message))
    this._revCount = (await rangeValues(this.home.view, 'rev/')).length
    await this._propagateAll().catch(noop)
    this.onevent({ ev: 'devices' })
  }

  async identityLog() {
    this._requireIdentity()
    return (await rangeValues(this.home.view, 'ev/')).map((e) => e.value)
  }

  // ---- comments (phase 3) -----------------------------------------------------

  async _room(work) {
    if (!schema.WORK.test(work)) throw new Error('Œuvre invalide')
    let room = this.rooms.get(work)
    if (!room) {
      const base = new Autobase(this.store.namespace('work/' + PROTOCOL + '/' + work), workBaseKey(work), {
        optimistic: true,
        valueEncoding: 'json',
        wakeup: this.wakeup,
        open: viewOf,
        apply: createRoomApply(work)
      })
      room = { base, refs: 0, timer: null, discovery: null, ready: base.ready() }
      this.rooms.set(work, room)
      await room.ready
      room.discovery = this._join(base.discoveryKey)
      this.relay.mirrorBase(base, 'room')
      base.on('update', () => this._notify('comments:' + work))
      this._propagateRevocations(base, 'work:' + work).catch(noop)
    }
    await room.ready
    return room
  }

  _retain(room, work, rooms = this.rooms) {
    room.refs++
    if (room.timer) clearTimeout(room.timer)
    room.timer = null
    return () => {
      if (--room.refs > 0) return
      room.timer = later(() => {
        if (room.refs > 0) return
        rooms.delete(work)
        if (room.discovery) room.discovery.destroy().catch(noop)
        room.base.close().catch(noop)
      }, ROOM_IDLE_MS)
    }
  }

  async listComments(work) {
    const room = await this._room(work)
    const view = room.base.view
    const me = this.secret ? this.secret.identity : null
    const horizon = Date.now() + FUTURE_SKEW_MS
    const all = (await rangeValues(view, 'c/')).map((e) => e.value).filter((cm) => cm.createdAt <= horizon)
    all.sort((a, b) => a.createdAt - b.createdAt)
    const out = all.slice(-MAX_COMMENTS)
    for (const cm of out) cm.likedByMe = me ? !!(await valueOf(view, 'l/' + cm.id + '/' + me)) : false
    return out
  }

  async postComment(input) {
    this._requireIdentity()
    const target = String(input && input.target)
    const work = seriesIdOfTarget(target)
    const room = await this._room(work)
    const release = this._retain(room, work)
    try {
      const me = this.secret.identity
      const stats = await valueOf(room.base.view, 'a/' + me)
      const ts = Date.now()
      if (!rateOk(stats, ts, this.secret.device.publicKey).ok) throw new Error('Trop de messages : patiente un peu')
      const text = String(input.text || '').trim()
      const body = {
        id: commentId(me, ts, target, text),
        target,
        parentId: input.parentId || undefined,
        text,
        spoiler: !!input.spoiler,
        timestamp: typeof input.timestamp === 'number' ? input.timestamp : undefined,
        name: (this.meProfile && this.meProfile.name) || 'moi'
      }
      const value = { v: 1, t: 'comment', room: 'work:' + work, ts, body: JSON.parse(JSON.stringify(body)) }
      const auth = await this._authFor(room.base)
      if (auth) value.auth = auth
      if (!schema.roomNode({ ...value, nonce: 0 }, work)) throw new Error('Commentaire invalide')
      const bits = pow.difficultyFor(stats)
      const t0 = Date.now()
      value.nonce = await pow.solve(pow.powPayload(value, toHex(room.base.local.key), me), bits)
      this.log('pow', bits, 'bits, nonce', value.nonce, 'in', Date.now() - t0, 'ms')
      await room.base.append(value, { optimistic: !room.base.writable })
      await room.base.update()
      const stored = await valueOf(room.base.view, 'c/' + body.id)
      if (!stored) throw new Error('Commentaire refusé')
      this._propagateRevocations(room.base, 'work:' + work).catch(noop)
      return { ...stored, likedByMe: false }
    } finally {
      release()
    }
  }

  async toggleLike(work, commentIdHex) {
    this._requireIdentity()
    const room = await this._room(work)
    const release = this._retain(room, work)
    try {
      const liked = !!(await valueOf(room.base.view, 'l/' + commentIdHex + '/' + this.secret.identity))
      await this._append(room.base, 'like', 'work:' + work, { id: commentIdHex, on: !liked }, { nonceBits: pow.DIFFICULTY.like })
    } finally {
      release()
    }
  }

  async editComment(work, commentIdHex, patch) {
    this._requireIdentity()
    const text = String((patch && patch.text) || '').trim()
    if (!text) throw new Error('Commentaire vide')
    const room = await this._room(work)
    const release = this._retain(room, work)
    try {
      await this._append(room.base, 'edit', 'work:' + work, { id: commentIdHex, text, spoiler: !!(patch && patch.spoiler) }, { nonceBits: pow.DIFFICULTY.like })
    } finally {
      release()
    }
  }

  async deleteComment(work, commentIdHex) {
    this._requireIdentity()
    const room = await this._room(work)
    const release = this._retain(room, work)
    try {
      await this._append(room.base, 'delete', 'work:' + work, { id: commentIdHex }, { nonceBits: pow.DIFFICULTY.like })
    } finally {
      release()
    }
  }

  async vouch(work, key) {
    this._requireIdentity()
    const room = await this._room(work)
    const stats = await valueOf(room.base.view, 'a/' + this.secret.identity)
    await this._append(room.base, 'vouch', 'work:' + work, { key }, { nonceBits: pow.difficultyFor(stats) })
  }

  // ---- moderation (phase 4) ---------------------------------------------------

  // ---- episode ↔ chapter corrections ---------------------------------------------

  async _mapRoom(key) {
    if (!schema.WORK.test(key)) throw new Error('Œuvre invalide')
    let room = this.mapRooms.get(key)
    if (!room) {
      const base = new Autobase(this.store.namespace('map/' + MAP_VERSION + '/' + key), mapBaseKey(key), {
        optimistic: true,
        valueEncoding: 'json',
        wakeup: this.wakeup,
        open: viewOf,
        apply: createMapApply(key)
      })
      room = { base, refs: 0, timer: null, discovery: null, ready: base.ready() }
      this.mapRooms.set(key, room)
      await room.ready
      room.discovery = this._join(base.discoveryKey)
      this.relay.mirrorBase(base, 'room')
      base.on('update', () => this._notify('mapping:' + key))
    }
    await room.ready
    return room
  }

  /** Every active proposal of a manhwa room (see MappingProposal in src/p2p/contract.ts). */
  async listMapping(key) {
    const room = await this._mapRoom(key)
    const out = []
    for (const e of await rangeValues(room.base.view, 'p/', { limit: MAX_MAPPING })) {
      const [, season, field, author] = e.key.split('/')
      const v = e.value
      if (field === 'end') out.push({ season, field: 'end', to: v.to, author, ts: v.ts })
      else out.push({ season, field: 'ep', ep: Number(field.slice(2)), from: v.from, to: v.to, author, ts: v.ts })
    }
    return out
  }

  async proposeMapping(input) {
    this._requireIdentity()
    const p = input || {}
    const key = String(p.room)
    const body =
      p.field === 'end'
        ? { s: String(p.season), f: 'end', b: p.to }
        : { s: String(p.season), f: 'ep', n: p.ep, a: p.from, b: p.to }
    if (!schema.mapBody(body)) throw new Error('Correction invalide')
    const room = await this._mapRoom(key)
    const release = this._retain(room, key, this.mapRooms)
    try {
      const me = this.secret.identity
      const stats = await valueOf(room.base.view, 'a/' + me)
      if (!rateOk(stats, Date.now(), this.secret.device.publicKey, MAP_RATE).ok) throw new Error('Patiente quelques secondes avant une nouvelle correction')
      const value = await this._append(room.base, 'map', 'map:' + key, body, { nonceBits: pow.difficultyFor(stats) })
      const stored = await valueOf(room.base.view, mapKey(body, me))
      if (!stored || stored.ts !== value.ts) throw new Error('Correction refusée')
    } finally {
      release()
    }
  }

  // ---- community reports of comments (flag rooms) ---------------------------------

  async _flagRoom(work) {
    if (!schema.WORK.test(work)) throw new Error('Œuvre invalide')
    let room = this.flagRooms.get(work)
    if (!room) {
      const base = new Autobase(this.store.namespace('flag/' + FLAG_VERSION + '/' + work), flagBaseKey(work), {
        optimistic: true,
        valueEncoding: 'json',
        wakeup: this.wakeup,
        open: viewOf,
        apply: createFlagApply(work)
      })
      room = { base, refs: 0, timer: null, discovery: null, ready: base.ready() }
      this.flagRooms.set(work, room)
      await room.ready
      room.discovery = this._join(base.discoveryKey)
      this.relay.mirrorBase(base, 'room')
      base.on('update', () => this._notify('flags:' + work))
    }
    await room.ready
    return room
  }

  /** Every active flag of a work (see CommentFlag in src/p2p/contract.ts). */
  async listFlags(work) {
    const room = await this._flagRoom(work)
    const out = []
    for (const e of await rangeValues(room.base.view, 'f/', { limit: MAX_FLAGS })) {
      const [, comment, author] = e.key.split('/')
      out.push({ comment, author, reason: e.value.r, ts: e.value.ts })
    }
    return out
  }

  async flagComment(work, commentIdHex, reason) {
    this._requireIdentity()
    const on = reason !== null && reason !== undefined
    const body = { id: String(commentIdHex), r: on ? reason : 'other', on }
    if (!schema.flagBody(body)) throw new Error('Signalement invalide')
    const room = await this._flagRoom(String(work))
    const release = this._retain(room, work, this.flagRooms)
    try {
      const me = this.secret.identity
      const key = flagKey(body.id, me)
      const prev = await valueOf(room.base.view, key)
      if (!on && !prev) return
      if (on && prev && prev.r === reason) return
      const stats = await valueOf(room.base.view, 'a/' + me)
      if (!rateOk(stats, Date.now(), this.secret.device.publicKey, FLAG_RATE).ok) throw new Error('Patiente quelques secondes avant un nouveau signalement')
      // Keep the previous reason when retracting (the body must name one).
      if (!on && prev) body.r = prev.r
      const value = await this._append(room.base, 'flag', 'flag:' + work, body, { nonceBits: pow.difficultyFor(stats) })
      const stored = await valueOf(room.base.view, key)
      if (on ? !stored || stored.ts !== value.ts : !!stored) throw new Error('Signalement refusé')
    } finally {
      release()
    }
  }

  async _flag(t, key, on) {
    this._requireIdentity()
    if (!isKey(key)) throw new Error('Clé invalide')
    await this._appendHome(t, { key, on })
  }

  follow(key) {
    return this._flag('follow', key, true)
  }
  unfollow(key) {
    return this._flag('follow', key, false)
  }
  block(key) {
    return this._flag('block', key, true)
  }
  unblock(key) {
    return this._flag('block', key, false)
  }

  async report(target, val) {
    this._requireIdentity()
    if (!schema.LABELS.includes(val) || typeof target !== 'string' || !target || target.length > 120) throw new Error('Signalement invalide')
    await this._appendHome('label', { target, val })
  }

  async subscribeLabeler(key) {
    await this._flag('sub', key, true)
    await this._openPeerHome(key)
  }

  async _labelsOf(by, base) {
    const out = []
    for (const e of await rangeValues(base.view, 'lab/')) out.push({ by, target: e.value.target, val: e.value.val, neg: e.value.neg, ts: e.value.ts })
    for (const e of await rangeValues(base.view, 'blk/')) out.push({ by, target: e.key.slice(4), val: 'hide', ts: e.value.ts })
    return out
  }

  async listLabels() {
    if (!this.home) return []
    const out = await this._labelsOf(this.secret.identity, this.home)
    for (const e of await rangeValues(this.home.view, 'sub/')) {
      const key = e.key.slice(4)
      const entry = this.homes.get(key)
      if (entry) out.push(...(await this._labelsOf(key, entry.base)))
    }
    return out.map((l) => JSON.parse(JSON.stringify(l)))
  }

  // ---- direct messages (phase 5) ---------------------------------------------

  async _openDm(peer) {
    let entry = this.dms.get(peer)
    if (entry) {
      await entry.ready
      return entry.base
    }
    const pair = dmPair(this.secret.identity, peer)
    const base = new Autobase(this.store.namespace('dm/' + PROTOCOL + '/' + peer), dmBaseKey(pair), {
      optimistic: true,
      valueEncoding: 'json',
      wakeup: this.wakeup,
      open: viewOf,
      apply: createDmApply(pair)
    })
    entry = { base, ready: base.ready(), discovery: null }
    this.dms.set(peer, entry)
    await entry.ready
    entry.discovery = this._join(base.discoveryKey)
    this.relay.mirrorBase(base, 'dm')
    base.on('update', () => this._onDmUpdate(peer).catch(noop))
    this._propagateRevocations(base, 'dm').catch(noop)
    return base
  }

  async _onDmUpdate(peer) {
    if (!(await valueOf(this.local, 'conv/' + peer))) {
      // No conversation yet: only a message from the peer that decrypts for me creates one.
      const entry = this.dms.get(peer)
      if (!entry || !(await this._hasMessageFrom(entry.base, peer))) return
      await this._ensureConversation(peer, { incoming: true })
    }
    this._notify('messages:' + peer)
    this._notify('conversations')
  }

  async _hasMessageFrom(base, peer) {
    if (!this.secret) return false
    for (const e of await rangeValues(base.view, 'm/')) if (e.value.from === peer && this._decrypt(e.value)) return true
    return false
  }

  async _ensureConversation(peer, { incoming }) {
    const existing = await valueOf(this.local, 'conv/' + peer)
    if (existing) {
      if (!this.dms.has(peer)) await this._openDm(peer)
      return existing
    }
    const following = this.home ? !!(await valueOf(this.home.view, 'fol/' + peer)) : false
    const conv = { peer, request: incoming && !following, lastRead: 0 }
    await this.local.put('conv/' + peer, conv)
    await this._openDm(peer)
    this._notify('conversations')
    return conv
  }

  _decrypt(m) {
    const mine = m.from === this.secret.identity
    const sealed = fromHex(mine ? m.s : m.r)
    let opened = null
    for (const kp of this._boxes()) if ((opened = seal.open(sealed, kp))) break
    if (!opened) return null
    let p = null
    try {
      p = JSON.parse(b4a.toString(opened))
    } catch {
      return null
    }
    if (!schema.dmPlain(p) || p.from !== m.from || p.id !== m.id) return null
    return p
  }

  async listMessages(peer) {
    this._requireIdentity()
    if (!isKey(peer)) return []
    const base = await this._openDm(peer)
    const peerState = (await valueOf(base.view, 's/' + peer)) || { seen: 0 }
    const out = []
    for (const e of await rangeValues(base.view, 'm/')) {
      const p = this._decrypt(e.value)
      if (!p) continue
      const mine = e.value.from === this.secret.identity
      out.push({ id: e.value.id, from: e.value.from, to: e.value.to, text: p.text, createdAt: e.value.ts, delivered: mine ? peerState.seen >= e.value.ts : true })
    }
    return out
  }

  async listConversations() {
    if (!this.secret) return []
    const out = []
    for (const e of await rangeValues(this.local, 'conv/')) {
      const conv = e.value
      const msgs = await this.listMessages(conv.peer)
      const last = msgs[msgs.length - 1]
      const info = this.peers.get(conv.peer) || {}
      out.push({
        peer: conv.peer,
        peerName: info.name || fingerprint(conv.peer),
        lastText: last ? last.text : '',
        lastAt: last ? last.createdAt : 0,
        unread: msgs.filter((m) => m.from === conv.peer && m.createdAt > conv.lastRead).length,
        request: !!conv.request
      })
    }
    out.sort((a, b) => b.lastAt - a.lastAt)
    return out
  }

  async sendMessage(peer, text) {
    this._requireIdentity()
    if (!isKey(peer) || peer === this.secret.identity) throw new Error('Destinataire invalide')
    text = String(text || '')
    if (!text.trim() || text.length > schema.LIMITS.dmText) throw new Error('Message invalide')
    let info = this.peers.get(peer)
    if (!info || !info.box) info = await this._lookup(peer)
    if (!info || !info.box || info.boxSrc !== 'profile') {
      // Seal to the box of the personal base, not to the one a device presented in its hello.
      const base = await this._openPeerHome(peer)
      if (base) await this._waitFor(() => this._refreshPeerName(peer, base), 4000)
      info = this.peers.get(peer)
    }
    if (!info || !info.box) throw new Error('Destinataire injoignable pour le moment')
    const conv = await this._ensureConversation(peer, { incoming: false })
    if (conv.request) await this.local.put('conv/' + peer, { ...conv, request: false })
    const base = await this._openDm(peer)
    const ts = Date.now()
    const id = toHex(crypto.randomBytes(16))
    const plain = JSON.stringify({ id, from: this.secret.identity, ts, text })
    const body = { id, to: peer, r: toHex(seal.seal(plain, fromHex(info.box))), s: toHex(seal.seal(plain, this._box().publicKey)) }
    const value = { v: 1, t: 'dm', room: 'dm', ts, body }
    const auth = await this._authFor(base)
    if (auth) value.auth = auth
    value.nonce = await pow.solve(pow.powPayload(value, toHex(base.local.key)), pow.DIFFICULTY.dm)
    await base.append(value, { optimistic: !base.writable })
    await base.update()
    this._propagateRevocations(base, 'dm').catch(noop)
    // Hint the peer (hello on their identity topic) so they open the conversation.
    this.dmHints.add(peer)
    this._join(idTopic(peer), { server: false, client: true })
    this._broadcastHello()
    return { id, from: this.secret.identity, to: peer, text, createdAt: ts, delivered: false }
  }

  async markRead(peer) {
    this._requireIdentity()
    const conv = await valueOf(this.local, 'conv/' + peer)
    if (!conv) return
    const msgs = await this.listMessages(peer)
    const lastIn = msgs.filter((m) => m.from === peer).pop()
    await this.local.put('conv/' + peer, { ...conv, lastRead: Date.now(), request: false })
    if (lastIn) {
      const base = await this._openDm(peer)
      const mine = (await valueOf(base.view, 's/' + this.secret.identity)) || { seen: 0 }
      if (lastIn.createdAt > mine.seen) await this._append(base, 'seen', 'dm', { upto: lastIn.createdAt }).catch(noop)
    }
    this._notify('conversations')
  }

  // ---- journal (phase 6) -------------------------------------------------------

  async appendJournal(entry) {
    this._requireIdentity()
    if (!schema.journalEntry(entry)) throw new Error('Entrée de journal invalide')
    const clean = entry.type === 'comment' ? { type: entry.type, work: entry.work, ts: entry.ts } : { type: entry.type, work: entry.work, unit: entry.unit, ts: entry.ts }
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = await valueOf(this.home.view, 'xphead')
      await this._appendHome('xp', { entry: clean, prev: head ? head.hash : null })
      const next = await valueOf(this.home.view, 'xphead')
      if (next && (!head || next.seq > head.seq)) return
    }
    throw new Error('Journal occupé, réessaie')
  }

  async journal(key) {
    let base = this.home
    if (key && (!this.secret || key !== this.secret.identity)) base = await this._openPeerHome(key)
    if (!base) return []
    await base.update().catch(noop)
    return (await rangeValues(base.view, 'xp/')).map((e) => e.value.entry)
  }

  // ---- community stats (opt-in) ---------------------------------------------------
  // Unlinkable by construction: a Corestore of its own (another primary key, nothing else in it
  // that a peer could ask for), a swarm with a throwaway key pair and no hello (the identity is
  // never presented there), and a fresh writer (random namespace) for every contribution.
  // Peers still see the IP address of the connection, as everywhere on a P2P network.

  _statsNet() {
    if (this.closed) throw new Error('Nœud fermé')
    if (!this.statsStore) {
      this.statsStore = new Corestore(this.storage + '-stats')
      this.statsLocal = new Hyperbee(this.statsStore.get({ name: 'stats-local' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
    }
    if (!this.statsSwarm) {
      this.statsWakeup = new ProtomuxWakeup()
      this.statsSwarm = new Hyperswarm({ keyPair: crypto.keyPair(), bootstrap: this.bootstrap })
      this.statsSwarm.on('connection', (conn) => {
        conn.on('error', noop)
        this.statsWakeup.addStream(this.statsStore.replicate(conn))
      })
    }
    this._touchStats()
  }

  _touchStats() {
    if (this._statsTimer) clearTimeout(this._statsTimer)
    this._statsTimer = later(() => this._closeStats().catch(noop), STATS_IDLE_MS)
  }

  async _closeStats() {
    if (this._statsTimer) clearTimeout(this._statsTimer)
    this._statsTimer = null
    const entries = [...this.statsBases.values()]
    this.statsBases.clear()
    for (const e of entries) {
      if (e.discovery) await e.discovery.destroy().catch(noop)
      await e.base.close().catch(noop)
    }
    const swarm = this.statsSwarm
    this.statsSwarm = null
    this.statsWakeup = null
    if (swarm) await swarm.destroy().catch(noop)
  }

  /** The month's stats room; `fresh` = a new writer nobody has seen (one per contribution). */
  async _statsBase(month, { fresh = false } = {}) {
    if (!stats.MONTH.test(month)) throw new Error('Mois invalide')
    this._statsNet()
    await this.statsStore.ready()
    await this.statsLocal.ready()
    let salt = await valueOf(this.statsLocal, 'salt/' + month)
    if (!salt || fresh) {
      salt = toHex(crypto.randomBytes(16))
      await this.statsLocal.put('salt/' + month, salt)
    }
    const id = month + '/' + salt
    let entry = this.statsBases.get(month)
    if (entry && entry.id !== id) {
      this.statsBases.delete(month)
      if (entry.discovery) entry.discovery.destroy().catch(noop)
      entry.base.close().catch(noop)
      entry = null
    }
    if (!entry) {
      const base = new Autobase(this.statsStore.namespace('stats/v' + stats.STATS_VERSION + '/' + id), statsBaseKey(month), {
        optimistic: true,
        valueEncoding: 'json',
        wakeup: this.statsWakeup,
        open: viewOf,
        apply: stats.createStatsApply(month)
      })
      entry = { id, base, discovery: null, ready: base.ready() }
      this.statsBases.set(month, entry)
      await entry.ready
      entry.discovery = this.statsSwarm ? this.statsSwarm.join(base.discoveryKey, { server: true, client: true }) : null
    }
    await entry.ready
    return entry
  }

  /** Publishes one anonymous contribution (src/stats/community.ts) in this month's room. */
  async contributeStats(c) {
    if (!stats.statsBody(c)) throw new Error('Statistiques invalides')
    const ts = Math.floor(Date.now() / stats.DAY_MS) * stats.DAY_MS
    const month = stats.monthOf(ts)
    const { base } = await this._statsBase(month, { fresh: true })
    const value = { v: 1, t: 'stat', room: 'stats:' + month, ts, body: { id: c.id, v: c.v, h: c.h, s: c.s } }
    value.nonce = await pow.solve(pow.powPayload(value, toHex(base.local.key)), stats.STATS_BITS)
    if (!stats.statsNode(value, month)) throw new Error('Statistiques invalides')
    await base.append(value, { optimistic: !base.writable })
    await base.update()
    if (!(await valueOf(base.view, 's/' + c.id))) throw new Error('Contribution refusée')
    // Stays reachable a few minutes so peers can fetch it.
    this._touchStats()
    return true
  }

  /** Sums of the contributions of this month and the previous one (the UI applies the k threshold). */
  async communityStats() {
    const now = Date.now()
    const d = new Date(now)
    const months = [stats.monthOf(now), stats.monthOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15))]
    const out = { contributions: 0, h: {}, s: [0, 0, 0] }
    const entries = await Promise.all(months.map((m) => this._statsBase(m)))
    // First open: give the swarm a moment to find peers.
    await withTimeout(Promise.all(entries.map((e) => (e.discovery ? e.discovery.flushed() : null))), LOOKUP_MS, null).catch(noop)
    for (const { base } of entries) {
      await withTimeout(base.update(), LOOKUP_MS, null).catch(noop)
      for (const e of await rangeValues(base.view, 's/', { limit: MAX_STATS_READ })) stats.mergeInto(out, e.value)
    }
    return out
  }

  // ---- Huwa relays (relay.js) -------------------------------------------------------

  /** `{ enabled, keys }` from the app settings (default key from the app config + user-added). */
  setRelays(cfg) {
    this._relayCfg = { enabled: !!(cfg && cfg.enabled !== false), keys: (cfg && Array.isArray(cfg.keys) ? cfg.keys : []).slice(0, 16) }
    return this.relay.configure(this._relayCfg)
  }

  relayStatus() {
    return this.relay.status()
  }

  // ---- subscriptions ------------------------------------------------------------

  /** Push-based watch. `emit(data)` is called now and after every relevant update. */
  watch(kind, arg, emit) {
    let topic
    let load
    let release = noop
    let stopped = false
    if (kind === 'comments') {
      topic = 'comments:' + arg
      load = () => this.listComments(arg)
      this._room(arg).then((room) => {
        // Unsubscribed while the room was opening: retain and release at once (idle close).
        release = this._retain(room, arg)
        if (stopped) release()
      }, noop)
    } else if (kind === 'mapping') {
      topic = 'mapping:' + arg
      load = () => this.listMapping(arg)
      this._mapRoom(arg).then((room) => {
        // Same as comments: a late room must not stay retained once nobody watches it.
        release = this._retain(room, arg, this.mapRooms)
        if (stopped) release()
      }, noop)
    } else if (kind === 'flags') {
      topic = 'flags:' + arg
      load = () => this.listFlags(arg)
      this._flagRoom(arg).then((room) => {
        release = this._retain(room, arg, this.flagRooms)
        if (stopped) release()
      }, noop)
    } else if (kind === 'labels') {
      topic = 'labels'
      load = () => this.listLabels()
    } else if (kind === 'conversations') {
      topic = 'conversations'
      load = () => this.listConversations()
    } else if (kind === 'messages') {
      topic = 'messages:' + arg
      load = () => this.listMessages(arg)
    } else {
      throw new Error('Abonnement inconnu: ' + kind)
    }
    let running = false
    let again = false
    let last = null
    const run = async () => {
      if (running) {
        again = true
        return
      }
      running = true
      try {
        do {
          again = false
          const data = await load()
          const json = JSON.stringify(data)
          if (json !== last) {
            last = json
            emit(data)
          }
        } while (again)
      } catch (err) {
        this.log('watch', kind, err.message)
      } finally {
        running = false
      }
    }
    const entry = { topic, run }
    const id = Symbol(topic)
    this.subs.set(id, () => {
      stopped = true
      release()
    })
    this._watchers = this._watchers || new Map()
    this._watchers.set(id, entry)
    run()
    return () => {
      this._watchers.delete(id)
      const stop = this.subs.get(id)
      this.subs.delete(id)
      if (stop) stop()
    }
  }

  _notify(topic) {
    if (!this._watchers) return
    for (const w of this._watchers.values()) if (w.topic === topic) w.run()
  }
}

module.exports = { HuwaNode, workBaseKey, dmBaseKey, mapBaseKey, flagBaseKey, idTopic }
