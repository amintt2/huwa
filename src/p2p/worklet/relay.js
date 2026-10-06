// Huwa relays: always-on Holepunch blind peers (services/blind-peer) asked, through
// `blind-peering`, to keep this device's cores available while every other peer is offline.
//
// What is kept, by priority (the relay clears the lowest priority first when it is full):
//   2  my account: the root-owned pointer core and my personal base (all its writers + view).
//      This is what makes "restore from the phrase with no other device online" work.
//   1  my conversations (DM bases): pending messages reach the peer while I am offline.
//   0  the public rooms I opened (comments, mapping, flags), bounded per session.
// Other people's personal bases are not pushed (their owner does it).
//
// The relay connection is a direct HyperDHT connection to the relay key (not a swarm topic): the
// relay replicates over it whatever it holds for the cores we ask about, and tells us (wakeup) the
// writer cores of a base it knows, which is how a fresh device finds a base nobody else serves.
const BlindPeering = require('blind-peering')
const IdEnc = require('hypercore-id-encoding')
const b4a = require('b4a')

const PRIORITY = { own: 2, dm: 1, room: 0 }
const MAX_RELAYS = 8
/** Public rooms pushed per session at most (the relay quota is the real bound). */
const MAX_ROOMS = 48
const noop = () => {}

/** Normalised z32 keys of the valid entries (hex or z32, 32 bytes), deduplicated, bounded. */
function parseRelayKeys(keys) {
  const out = []
  for (const k of Array.isArray(keys) ? keys : []) {
    if (typeof k !== 'string') continue
    try {
      const buf = IdEnc.decode(k.trim())
      if (buf.byteLength !== 32) continue
      const id = IdEnc.normalize(buf)
      if (!out.includes(id)) out.push(id)
    } catch {
      // not a key
    }
    if (out.length >= MAX_RELAYS) break
  }
  return out
}

class RelayMirror {
  constructor({ log = noop } = {}) {
    this.log = log
    this.enabled = false
    this.keys = []
    this.peering = null
    this.net = null // { dht, store, wakeup }
    this.suspended = false
    this.closed = false
    // Everything asked for this session, re-asked when the relays change or come back on.
    this.cores = new Map() // core -> opts
    this.bases = new Map() // base -> opts
    this.rooms = 0
  }

  /** Called once the swarm exists. */
  attach({ dht, store, wakeup }) {
    this.net = { dht, store, wakeup }
    this._apply()
  }

  /** `{ enabled, keys }`: on/off and the relay keys (default + user-added, merged by the app). */
  configure(cfg = {}) {
    const keys = parseRelayKeys(cfg.keys)
    const enabled = cfg.enabled !== false && keys.length > 0
    const same = enabled === this.enabled && keys.join() === this.keys.join()
    this.enabled = enabled
    this.keys = keys
    if (!same) this._apply()
    return this.status()
  }

  get active() {
    return !!this.peering
  }

  _blindPeers() {
    return this.keys.map((key) => ({ key }))
  }

  _apply() {
    if (this.closed || !this.net) return
    if (this.peering) {
      // A fresh instance rather than setBlindPeers(): the latter keeps the connections (and the
      // retries) to relays that were removed from the list.
      const p = this.peering
      this.peering = null
      p.close().catch(noop)
    }
    if (!this.enabled) {
      this.log('relais désactivés')
      return
    }
    this.peering = new BlindPeering(this.net.dht, this.net.store, {
      wakeup: this.net.wakeup,
      blindPeers: this._blindPeers(),
      suspended: this.suspended,
      client: { name: 'huwa', version: '1' }
    })
    this.log('relais', this.keys.length)
    for (const [core, opts] of this.cores) this._addCore(core, opts)
    for (const [base, opts] of this.bases) this._addBase(base, opts)
  }

  _pick() {
    return Math.min(2, this.keys.length || 1)
  }

  _addCore(core, opts) {
    if (!this.peering) return
    this.peering.addCoreBackground(core, { priority: opts.priority, referrer: opts.referrer || undefined, announce: false, pick: this._pick() })
  }

  _addBase(base, opts) {
    if (!this.peering) return
    this.peering.addAutobaseBackground(base, { priority: opts.priority, announce: false, pick: this._pick() })
  }

  /** Keeps a single core (pointer). `referrer`: the key it is grouped (and quota-counted) with. */
  mirrorCore(core, { priority = PRIORITY.own, referrer = null } = {}) {
    if (this.closed || !core || this.cores.has(core)) return
    const opts = { priority, referrer }
    this.cores.set(core, opts)
    core.once('close', () => this.cores.delete(core))
    this._addCore(core, opts)
  }

  /** Keeps an Autobase (writers + view). `kind`: own | dm | room. */
  mirrorBase(base, kind = 'room') {
    if (this.closed || !base || this.bases.has(base)) return
    if (kind === 'room') {
      if (this.rooms >= MAX_ROOMS) return
      this.rooms++
    }
    const opts = { priority: PRIORITY[kind] ?? PRIORITY.room, kind }
    this.bases.set(base, opts)
    base.once('close', () => this.bases.delete(base))
    this._addBase(base, opts)
  }

  /**
   * Asks the relays for `core` and resolves once its first block arrived (or after `ms`): used by
   * the restore, where the pointer core may live on a relay only.
   */
  async fetch(core, ms) {
    if (!this.peering || this.closed) return false
    await core.ready()
    // Priority 0: a device restoring must not upgrade (or reset) what the owner asked for.
    this.peering.addCoreBackground(core, { priority: 0, announce: false, pick: this.keys.length })
    const deadline = Date.now() + ms
    while (Date.now() < deadline && !core.closing) {
      if (core.length > 0) return true
      await core.update({ wait: false }).catch(noop)
      if (core.length > 0) return true
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return core.length > 0
  }

  status() {
    let connected = 0
    if (this.peering) for (const p of this.peering.blindPeers.values()) if (p.connected) connected++
    return { enabled: this.enabled, relays: this.keys.length, connected, cores: this.cores.size, bases: this.bases.size }
  }

  async suspend() {
    this.suspended = true
    if (this.peering) await this.peering.suspend().catch(noop)
  }

  async resume() {
    this.suspended = false
    if (this.peering) await this.peering.resume().catch(noop)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.cores.clear()
    this.bases.clear()
    if (this.peering) await this.peering.close().catch(noop)
    this.peering = null
  }
}

/** Grouping key of the pointer core on the relay: the personal base it points to. */
function homeReferrer(home) {
  return home && home.wakeupCapability ? b4a.from(home.wakeupCapability.key) : null
}

module.exports = { RelayMirror, parseRelayKeys, homeReferrer, PRIORITY, MAX_ROOMS }
