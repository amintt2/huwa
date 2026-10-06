// Huwa storage policy on top of the `blind-peer` library (holepunchto/blind-peer@3.15.x).
//
// What the library does natively (read in node_modules/blind-peer/index.js and lib/db.js):
//   - one total budget (`maxBytes`): beyond it, `_gc()` clears the blocks of the least useful
//     cores first, ordered by the `cores-by-activity` index = (priority, last activity). Records
//     stay (a client that comes back re-uploads), announced cores are never cleared.
//   - priority per request: 0..2 for any client (3 is not reachable, 2 is the max stored).
//   - optional rate limit of add-cores requests per referrer (`perReferrerRateLimitParams`).
//   - no quota per client / per referrer, no expiry of forgotten cores.
//
// What this module adds:
//   - quota per group: a group is the `referrer` of the record (the Autobase wakeup key for an
//     Autobase's cores; the Huwa app passes the personal base's key as referrer for its pointer
//     core too), or the core itself without referrer. Over `groupQuotaBytes`, the group's least
//     useful cores (same order as the library: priority, then last activity) are cleared.
//   - expiry: a core neither requested nor replicated for `maxIdleMs` (120 days by default) is
//     deleted (blocks and record).
//   - "last requested": every add-cores request refreshes the record's `active` timestamp (the
//     library only refreshes it on upload/download, so an up-to-date account that just checks in
//     would otherwise look idle).
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const IdEnc = require('hypercore-id-encoding')

const DAY = 24 * 3600 * 1000
const DEFAULTS = {
  groupQuotaBytes: 50 * 1e6,
  maxIdleMs: 120 * DAY,
  sweepIntervalMs: 3600 * 1000
}

const noop = () => {}
const hex = (buf) => b4a.toString(buf, 'hex')

class HuwaPolicy {
  /**
   * @param {import('blind-peer')} bp  an opened (or opening) BlindPeer
   * @param {{ groupQuotaBytes?: number, maxIdleMs?: number, sweepIntervalMs?: number, now?: () => number, log?: Function }} [opts]
   */
  constructor(bp, opts = {}) {
    this.bp = bp
    this.groupQuotaBytes = opts.groupQuotaBytes ?? DEFAULTS.groupQuotaBytes
    this.maxIdleMs = opts.maxIdleMs ?? DEFAULTS.maxIdleMs
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULTS.sweepIntervalMs
    this.now = opts.now || Date.now
    this.log = opts.log || noop
    this.timer = null
    this.sweeping = null
    this.stats = { sweeps: 0, expired: 0, groupCleared: 0, bytesCleared: 0, touched: 0 }
    this._ontouch = (stream, request) => this._touch(request).catch((err) => this.log('touch', err.message))
  }

  start() {
    this.bp.on('add-cores-received', this._ontouch)
    if (this.sweepIntervalMs > 0) {
      this.timer = setInterval(() => this.sweep().catch((err) => this.log('sweep', err.message)), this.sweepIntervalMs)
      if (this.timer.unref) this.timer.unref()
    }
  }

  async stop() {
    this.bp.off('add-cores-received', this._ontouch)
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.sweeping) await this.sweeping.catch(noop)
  }

  /** Marks the requested cores as alive (the flush sets `active` to now). */
  async _touch(request) {
    const db = this.bp.db
    if (!db || this.bp.closing) return
    for (const c of request.cores || []) {
      const tracker = this.bp.activeReplication.get(hex(discoveryKeyOf(c.key)))
      if (tracker && tracker.record) {
        // Same record object and id as the tracker: no stale length / byte count.
        db.updateCore(tracker.record, tracker.id)
      } else {
        const record = await db.getCoreRecord(c.key)
        if (record) db.updateCore(record, IdEnc.normalize(c.key))
      }
      this.stats.touched++
    }
  }

  /** One pass: expire forgotten cores, then enforce the per-group quota. Never concurrent. */
  sweep() {
    if (!this.sweeping) {
      this.sweeping = this._sweep().finally(() => {
        this.sweeping = null
      })
    }
    return this.sweeping
  }

  async _sweep() {
    const bp = this.bp
    if (!bp.opened) await bp.ready()
    if (bp.closing) return
    // Same lock as the library's own GC and flushes.
    while (!(await bp.lock.lock())) {
      if (bp.closing || bp.lock.destroyed) return
    }
    try {
      if (bp.db.updated()) await bp.db.flush()
      const now = this.now()
      const groups = new Map()
      const expired = []
      for await (const r of bp.db.find('@blind-peer/cores', {})) {
        if (r.announce) continue // only trusted peers announce; their cores are managed by them
        if (now - r.active > this.maxIdleMs) {
          expired.push(r)
          continue
        }
        const id = hex(r.referrer || r.key)
        let g = groups.get(id)
        if (!g) groups.set(id, (g = { bytes: 0, records: [] }))
        g.bytes += r.bytesAllocated
        g.records.push(r)
      }

      for (const r of expired) {
        if (bp.closing) return
        await this._delete(r.key)
        this.stats.expired++
      }

      for (const g of groups.values()) {
        if (g.bytes <= this.groupQuotaBytes) continue
        g.records.sort((a, b) => a.priority - b.priority || a.active - b.active)
        for (const r of g.records) {
          if (g.bytes <= this.groupQuotaBytes || bp.closing) break
          if (r.bytesAllocated === 0) continue
          const cleared = await this._clear(r.key)
          g.bytes -= cleared
          this.stats.bytesCleared += cleared
          this.stats.groupCleared++
        }
      }
      await bp.db.flush()
      this.stats.sweeps++
      this.log('sweep done', { expired: expired.length, groups: groups.size })
    } finally {
      bp.lock.unlock()
    }
  }

  /** Clears the blocks of a core (the record stays: a client that comes back re-uploads). */
  async _clear(key) {
    const bp = this.bp
    const core = bp.store.get({ key })
    await core.ready()
    try {
      const tracker = bp.activeReplication.get(hex(core.discoveryKey))
      if (!tracker) return 0
      await tracker.refresh()
      if (!tracker.record) return 0
      return tracker.gc()
    } finally {
      await core.close().catch(noop)
    }
  }

  /** Deletes a core: blocks and record (mirrors the library's trusted `delete-core` RPC). */
  async _delete(key) {
    const bp = this.bp
    const core = bp.store.get({ key })
    await core.ready()
    try {
      const tracker = bp.activeReplication.get(hex(core.discoveryKey))
      if (tracker) await tracker.core.close().catch(noop)
      await core.clear(0, core.length)
      bp.db.deleteCore(key)
    } finally {
      await core.close().catch(noop)
    }
  }

  /** Bytes per group, largest first (diagnostics / health endpoint). */
  async groups(limit = 10) {
    const out = new Map()
    for await (const r of this.bp.db.find('@blind-peer/cores', {})) {
      const id = hex(r.referrer || r.key)
      out.set(id, (out.get(id) || 0) + r.bytesAllocated)
    }
    return [...out].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([group, bytes]) => ({ group, bytes }))
  }
}

function discoveryKeyOf(key) {
  return crypto.discoveryKey(key)
}

module.exports = { HuwaPolicy, DEFAULTS }
