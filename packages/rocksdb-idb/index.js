// rocksdb-idb: the subset of rocksdb-native (3.x) that hypercore-storage (3.x) uses, for browsers
// (a SharedWorker / Worker / page), over IndexedDB. No Node-only APIs.
//
// Covered surface, mirroring rocksdb-native's JS API and the private fields hypercore-storage reads
// (`_snapshot`, `_state.closing`, `_index`):
//   new RocksDB(name, opts) · ready · close · suspend · resume · flush · compactRange · compact
//   session({ columnFamily, snapshot }) · columnFamily(cf) · snapshot() · snapshotted · path
//   read() -> ReadBatch { get, flush, tryFlush, destroy }
//   write() -> WriteBatch { put, tryPut, delete, tryDelete, deleteRange, tryDeleteRange, flush, tryFlush, destroy }
//   get / put / delete / deleteRange / peek / keys · iterator({ gt, gte, lt, lte, reverse, limit, values })
//   persistenceStats · storageError · RocksDB.ColumnFamily · RocksDB.destroy(name)
// Package exports: aesGcmCipher, storageEstimate, requestPersist, RocksDBIDBError.
//
// Design:
// - Key index in memory: per column family, the sorted array of live keys (lib/table.js), loaded at
//   open with getAllKeys. Values are NOT loaded: clean values are read from IndexedDB on demand and
//   kept in a byte-bounded LRU; dirty values (not yet compacted into `kv`) are pinned in memory.
// - Writes: a write batch becomes visible when its group commit is durable. Batches flushed while a
//   commit is in flight form the next group, written as ONE record of the `wal` store; then the
//   group is applied to memory synchronously (atomic). A background compaction applies WAL records
//   to `kv` (coalesced, one transaction that also deletes them); at open the WAL is replayed over
//   `kv`. A batch is all-or-nothing on disk (one WAL record, or one compaction transaction).
// - MVCC snapshots: every live snapshot keeps an undo log of the keys changed after it was taken.
//   Before a group is applied, the old values the snapshots need and that are not in memory are
//   read from `kv`. Iterators take an implicit snapshot (scoped to their range) as RocksDB does, and
//   read values for a run of keys in one IndexedDB request.
// - Storage errors: a failed WAL commit / compaction rejects the affected batches with a coded error
//   (QUOTA_EXCEEDED, IDB_ERROR; see lib/errors.js), calls `onerror(err)`, and makes the database
//   read-only until reopened: memory then holds exactly the acknowledged batches, which are all on
//   disk, so nothing diverges silently. Reads keep working. `db.storageError` is that error.
//
// Options:
//   indexedDB, IDBKeyRange  default globalThis's; indexedDB: null = memory only (no persistence)
//   name                    IndexedDB database name (default: the path)
//   durability              'relaxed' (default) | 'strict' | 'default' for write transactions
//   cacheBytes              LRU budget for clean values (default 32 MiB)
//   cipher                  { encrypt(u8) => Promise<u8>, decrypt(u8) => Promise<u8> }: values and
//                           WAL records are sealed at rest, keys stay clear (byte order). Must be set
//                           when the database is created; see aesGcmCipher (lib/cipher.js)
//   lock                    single-writer Web Lock `rocksdb-idb:<name>` (ifAvailable; ready() rejects
//                           with code LOCKED when held), on whenever a LockManager exists; `false`
//                           turns it off (other values, e.g. rocksdb-native's device file, are ignored)
//   locks                   LockManager to use (default navigator.locks; tests inject one)
//   onerror                 (err) => void, called once when a storage error makes the db read-only
//   walMaxRecords           compact when this many WAL records are pending (default 64)
//   walMaxBytes             ... or this many WAL bytes (default 4 MiB)
//   compactDelay            ... or after this many ms without writes (default 500; false: never)
//   autoCompact             false: compact only on flush / compactRange / close (default true)
//   keyEncoding, valueEncoding  compact-encoding encodings (sessions)
const { Readable } = require('streamx')
const b4a = require('b4a')
const { Table, lowerBound, inLower, inUpper, nextInSorted } = require('./lib/table')
const { IDBPersistence } = require('./lib/idb')
const { LRU } = require('./lib/lru')
const { encodeOps, decodeOps, own } = require('./lib/codec')
const { RocksDBIDBError, storageError } = require('./lib/errors')
const { aesGcmCipher } = require('./lib/cipher')
const { storageEstimate, requestPersist } = require('./lib/storage')

const EMPTY = b4a.alloc(0)
const CIPHER_MAGIC = b4a.from('rocksdb-idb cipher check v1')

const GET = 0
const PUT = 1 // same op codes as lib/codec.js
const DELETE = 2
const DELETE_RANGE = 3

class ColumnFamily {
  constructor(name, opts = {}) {
    if (typeof name !== 'string' || !name || name.includes('/')) throw new Error('Invalid column family name')
    this.name = name
    this.opts = opts
  }

  cloneSettings(name) {
    return new ColumnFamily(name, this.opts)
  }

  get _handle() {
    return this
  }
}

class Snapshot {
  /** scope: null (whole db) or { cf, b } (an iterator's range: only those keys are recorded). */
  constructor(state, scope = null) {
    this.state = state
    this.scope = scope
    this.undo = new Map() // cf -> Map(hex -> value | null): values as of the snapshot
    this.sorted = new Map() // cf -> { size, keys } sorted undo keys, rebuilt when the undo grows
    this.refs = 0
    state.snapshots.add(this)
  }

  covers(cf, hex) {
    const s = this.scope
    return s === null || (s.cf === cf && inLower(hex, s.b) && inUpper(hex, s.b))
  }

  recorded(cf, hex) {
    const m = this.undo.get(cf)
    return m !== undefined && m.has(hex)
  }

  record(cf, hex, prev) {
    let m = this.undo.get(cf)
    if (!m) {
      m = new Map()
      this.undo.set(cf, m)
    }
    if (!m.has(hex)) m.set(hex, prev)
  }

  undoKeys(cf) {
    const m = this.undo.get(cf)
    if (!m) return null
    let s = this.sorted.get(cf)
    if (!s || s.size !== m.size) {
      s = { size: m.size, keys: [...m.keys()].sort() }
      this.sorted.set(cf, s)
    }
    return s.keys
  }

  ref() {
    this.refs++
  }

  unref() {
    if (--this.refs > 0) return
    this.state.snapshots.delete(this)
    this.undo.clear()
    this.sorted.clear()
  }
}

class State {
  constructor(db, path, opts) {
    const { columnFamily = new ColumnFamily('default', opts), columnFamilies = [] } = opts
    this.db = db
    this.path = path
    this.opts = opts
    this.sessions = []
    this.columnFamilies = [columnFamily]
    for (const cf of columnFamilies) this.columnFamilies.push(typeof cf === 'string' ? new ColumnFamily(cf, opts) : cf)
    this.tables = new Map() // cf name -> Table
    this.snapshots = new Set()
    this.opened = false
    this.closing = false
    this.closed = false
    this.suspended = false
    this.handles = 0
    this.stats = { gets: 0, puts: 0, deletes: 0, rangeDeletes: 0, readBatches: 0, writeBatches: 0 }

    const idb = opts.indexedDB !== undefined ? opts.indexedDB : globalThis.indexedDB
    const KeyRange = opts.IDBKeyRange !== undefined ? opts.IDBKeyRange : globalThis.IDBKeyRange
    this.name = opts.name || path
    this.persistence = idb
      ? new IDBPersistence(this.name, { indexedDB: idb, IDBKeyRange: KeyRange, durability: opts.durability, onlost: (err) => this._fail(err) })
      : null

    this.cache = new LRU(opts.cacheBytes === undefined ? 32 * 1024 * 1024 : opts.cacheBytes)
    this.cacheStats = { hits: 0, misses: 0 }
    this.cipher = opts.cipher || null
    this.onerror = opts.onerror || null
    this.error = null // storage error: read-only until reopened

    const nav = globalThis.navigator
    this.locks = opts.locks || (nav && nav.locks) || null
    // `lock` is also rocksdb-native's device-file option (hypercore-storage passes one): only a
    // boolean is ours.
    this.lock = this.persistence !== null && this.locks !== null && opts.lock !== false
    this._releaseLock = null

    // Write pipeline (persistent mode).
    this.pending = [] // [{ ops, resolve, reject }] waiting for the next group commit
    this.writing = null // writer loop (commits and compactions, one at a time)
    this.seq = 1 // next WAL record key
    this.unflushed = [] // [{ seq, ops, bytes }] in the WAL, not yet compacted into kv
    this.walBytes = 0
    this.walMaxRecords = opts.walMaxRecords || 64
    this.walMaxBytes = opts.walMaxBytes || 4 * 1024 * 1024
    this.compactDelay = opts.compactDelay === undefined ? 500 : opts.compactDelay
    this.autoCompact = opts.autoCompact !== false
    this.compactRequested = false
    this.compactTimer = null
    this.inflight = new Map() // kv key -> { n, stale }: reads in flight (a write marks them stale)

    this._opening = null
    this._closing = null
  }

  getColumnFamily(cf) {
    if (!cf) return this.columnFamilies[0]
    if (typeof cf === 'string') {
      for (const c of this.columnFamilies) if (c.name === cf) return c
      const c = this.columnFamilies[0].cloneSettings(cf)
      this.columnFamilies.push(c)
      return c
    }
    if (!this.columnFamilies.includes(cf)) {
      const same = this.columnFamilies.find((c) => c.name === cf.name)
      if (same) return same
      this.columnFamilies.push(cf)
    }
    return cf
  }

  table(cf) {
    return this.tableByName(cf.name)
  }

  tableByName(name) {
    let t = this.tables.get(name)
    if (!t) {
      t = new Table(name)
      this.tables.set(name, t)
    }
    return t
  }

  ready() {
    if (this._opening === null) this._opening = this._open()
    return this._opening
  }

  async _open() {
    if (this.persistence === null) {
      this.opened = true
      return
    }
    try {
      if (this.lock) await this._acquireLock()
      const { keys, wal, cipher } = await this.persistence.open()
      await this._checkCipher(cipher, keys.length === 0 && wal.length === 0)
      let t = null
      for (const k of keys) {
        const i = k.indexOf('/')
        const cf = k.slice(0, i)
        if (t === null || t.name !== cf) t = this.tableByName(cf)
        t.keys.push(k.slice(i + 1)) // getAllKeys returns them sorted
      }
      // WAL replay: records not compacted yet are applied over kv and stay pinned until compacted.
      for (const [seq, sealed] of wal) {
        const ops = this._internalOps(decodeOps(await this._unseal(sealed, 'WAL record ' + seq)), false)
        this._apply(ops, seq, null)
        this.unflushed.push({ seq, ops, bytes: sealed.byteLength })
        this.walBytes += sealed.byteLength
        if (seq >= this.seq) this.seq = seq + 1
      }
      this.persistence.stats.replayed = wal.length
    } catch (err) {
      this.persistence.close()
      this._unlock()
      throw err
    }
    this.opened = true
    this._scheduleCompaction()
  }

  _acquireLock() {
    return new Promise((resolve, reject) => {
      const name = 'rocksdb-idb:' + this.name
      Promise.resolve(
        this.locks.request(name, { ifAvailable: true }, (lock) => {
          if (!lock) {
            reject(new RocksDBIDBError('Database "' + this.name + '" is open in another tab or worker', 'LOCKED'))
            return
          }
          return new Promise((release) => {
            this._releaseLock = release
            resolve()
          })
        })
      ).catch(reject)
    })
  }

  _unlock() {
    const release = this._releaseLock
    this._releaseLock = null
    if (release) release()
  }

  async _checkCipher(check, empty) {
    if (this.cipher === null) {
      if (check !== undefined) throw new RocksDBIDBError('Database "' + this.name + '" is encrypted: pass its cipher', 'CIPHER_MISMATCH')
      return
    }
    if (check === undefined) {
      if (!empty) throw new RocksDBIDBError('Database "' + this.name + '" was created without a cipher', 'CIPHER_MISMATCH')
      await this.persistence.putMeta('cipher', await this._seal(CIPHER_MAGIC))
      return
    }
    const magic = await this._unseal(check, 'cipher check')
    if (!b4a.equals(magic, CIPHER_MAGIC)) throw new RocksDBIDBError('Cipher check failed (wrong key)', 'DECRYPT_FAILED')
  }

  async _seal(u8) {
    try {
      return await this.cipher.encrypt(u8)
    } catch (err) {
      throw new RocksDBIDBError('Encryption failed: ' + (err && err.message), 'IDB_ERROR', err)
    }
  }

  /** Bytes as stored -> plain Uint8Array (decrypted when there is a cipher). */
  async _unseal(v, what) {
    const u8 = v instanceof Uint8Array ? v : new Uint8Array(v)
    if (this.cipher === null) return u8
    let out
    try {
      out = await this.cipher.decrypt(u8)
    } catch (err) {
      throw new RocksDBIDBError('Cannot decrypt ' + what + ' (wrong key or corrupted data)', 'DECRYPT_FAILED', err)
    }
    return out instanceof Uint8Array ? out : new Uint8Array(out)
  }

  addSession(db) {
    db._index = this.sessions.push(db) - 1
    if (db._snapshot) db._snapshot.ref()
  }

  removeSession(db) {
    const head = this.sessions.pop()
    if (head !== db) this.sessions[(head._index = db._index)] = head
    db._index = -1
    if (db._snapshot) db._snapshot.unref()
  }

  close() {
    if (this._closing === null) this._closing = this._close()
    return this._closing
  }

  async _close() {
    this.closing = true
    await this.ready().catch(noop)
    if (this.persistence !== null && this.opened) {
      await this.flush().catch(noop) // commits and compacts everything (unless read-only)
      clearTimeout(this.compactTimer)
      this.compactTimer = null
      this.persistence.close()
    }
    this._unlock()
    this.closed = true
  }

  /** Storage error: reject what waits, report once, become read-only. */
  _fail(err) {
    if (this.error !== null || this.closed) return
    this.error = err
    clearTimeout(this.compactTimer)
    this.compactTimer = null
    this._rejectPending()
    if (this.onerror !== null) {
      try {
        this.onerror(err)
      } catch {}
    }
  }

  _rejectPending() {
    const pending = this.pending
    this.pending = []
    for (const g of pending) g.reject(this._readOnlyError())
  }

  _readOnlyError() {
    const e = this.error
    return new RocksDBIDBError('Database is read-only after a storage error (reopen it): ' + e.message, e.code, e)
  }

  /** Batch ops -> internal ops ({ type, table, cf, hex, key, value?, end?, endHex? }). */
  _internalOps(operations, copyBuffers) {
    const out = new Array(operations.length)
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i]
      const table = typeof op.cf === 'string' ? this.tableByName(op.cf) : this.table(op.cf)
      const key = copyBuffers ? copy(op.key) : op.key
      const o = { type: op.type, table, cf: table.name, hex: b4a.toString(key, 'hex'), key, value: null, end: null, endHex: null }
      // Stored values get their own exact-size buffer: IndexedDB's structured clone of a view
      // copies its whole ArrayBuffer (a pooled Buffer slice would store the pool slab).
      if (op.type === PUT) o.value = copyBuffers ? own(op.value) : op.value
      else if (op.type === DELETE_RANGE) {
        o.end = copyBuffers ? copy(op.end) : op.end
        o.endHex = b4a.toString(o.end, 'hex')
      }
      out[i] = o
    }
    return out
  }

  /** Persists and applies a write batch; resolves once it is durable and visible. */
  write(operations) {
    const ops = this._internalOps(operations, true)
    if (this.persistence === null) {
      this._apply(ops, Infinity, null)
      return Promise.resolve()
    }
    if (this.error !== null) return Promise.reject(this._readOnlyError())
    return new Promise((resolve, reject) => {
      this.pending.push({ ops, resolve, reject })
      this._kick()
    })
  }

  _kick() {
    if (this.writing === null) this.writing = this._writer()
  }

  async _writer() {
    await Promise.resolve() // let the current tick add its batches to the same group
    try {
      while (this.error === null) {
        if (this.pending.length > 0) await this._commit()
        else if (this.unflushed.length > 0 && (this.compactRequested || this._compactionDue())) await this._compact()
        else break
      }
    } catch (err) {
      this._fail(storageError(err, 'write'))
    } finally {
      this.compactRequested = false
      this.writing = null
    }
    if (this.error !== null && this.pending.length > 0) this._rejectPending()
    this._scheduleCompaction()
  }

  _compactionDue() {
    return this.autoCompact && (this.unflushed.length >= this.walMaxRecords || this.walBytes >= this.walMaxBytes)
  }

  _scheduleCompaction() {
    if (!this.autoCompact || this.error !== null || this.closing || this.unflushed.length === 0) return
    if (this.writing !== null || this.compactTimer !== null) return
    if (this._compactionDue()) return this._kick()
    if (this.compactDelay === false || this.compactDelay === null) return
    this.compactTimer = setTimeout(() => {
      this.compactTimer = null
      this.compactRequested = true
      this._kick()
    }, this.compactDelay)
    if (typeof this.compactTimer === 'object' && this.compactTimer.unref) this.compactTimer.unref()
  }

  async _commit() {
    const group = this.pending
    this.pending = []
    clearTimeout(this.compactTimer)
    this.compactTimer = null
    const ops = group.length === 1 ? group[0].ops : [].concat(...group.map((g) => g.ops))
    const seq = this.seq++
    let walDone = false
    try {
      let rec = encodeOps(ops)
      if (this.cipher !== null) rec = await this._seal(rec)
      // The old values live snapshots need are read from kv while the WAL record is written.
      const old = new Map()
      let need = this._needOld(ops, old)
      const [w, o] = await Promise.allSettled([
        this.persistence.appendWal(seq, rec, group.length, ops.length),
        need.length > 0 ? this._fetch(need, false) : null
      ])
      if (w.status === 'rejected') throw w.reason
      walDone = true
      if (o.status === 'rejected') throw o.reason
      if (o.value !== null) for (let i = 0; i < need.length; i++) old.set(need[i], o.value[i])
      // A snapshot taken meanwhile (or a cache eviction) may need more. The last check and the
      // apply run in the same tick, so nothing can change in between.
      while ((need = this._needOld(ops, old)).length > 0) {
        const values = await this._fetch(need, false)
        for (let i = 0; i < need.length; i++) old.set(need[i], values[i])
      }
      this._apply(ops, seq, old)
      this.unflushed.push({ seq, ops, bytes: rec.byteLength })
      this.walBytes += rec.byteLength
    } catch (e) {
      // WAL failed: nothing changed in memory or on disk. WAL written but not applied: the batch
      // is on disk (it comes back at reopen) but not in memory. Either way: read-only from now on.
      const err = storageError(e, 'write')
      if (walDone) err.durable = true
      this._fail(err)
      for (const g of group) g.reject(err)
      return
    }
    for (const g of group) g.resolve()
  }

  /** Keys of `ops` whose current value a live snapshot needs and that is not in memory. */
  _needOld(ops, old) {
    if (this.snapshots.size === 0) return []
    const snaps = [...this.snapshots]
    const need = []
    const seen = new Set()
    const check = (t, hex) => {
      const k = t.prefix + hex
      if (seen.has(k)) return
      seen.add(k)
      if (this._resident(t, hex, old) !== undefined) return
      for (const s of snaps) {
        if (s.covers(t.name, hex) && !s.recorded(t.name, hex)) {
          need.push(k)
          return
        }
      }
    }
    for (const op of ops) {
      const t = op.table
      if (op.type === DELETE_RANGE) {
        for (const hex of t.range(op.hex, op.endHex)) check(t, hex)
      } else if (t.has(op.hex)) {
        check(t, op.hex)
      }
    }
    return need
  }

  /** Current value if in memory (dirty, cache, or prefetched `old`), else undefined. */
  _resident(t, hex, old) {
    const d = t.dirty.get(hex)
    if (d !== undefined) return d.value
    const k = t.prefix + hex
    const c = this.cache.peek(k)
    if (c !== undefined) return c
    if (old !== null) {
      const o = old.get(k)
      if (o !== undefined) return o
    }
    return undefined
  }

  /** Applies ops to memory, synchronously (a group is atomic for readers). */
  _apply(ops, seq, old) {
    const snaps = this.snapshots.size > 0 ? [...this.snapshots] : null
    for (const op of ops) {
      const t = op.table
      if (op.type === PUT) {
        const existed = t.has(op.hex)
        if (snaps !== null) this._record(snaps, t, op.hex, existed, old)
        if (!existed) t.insert(op.hex)
        t.dirty.set(op.hex, { value: op.value, seq })
        this._invalidate(t.prefix + op.hex)
      } else if (op.type === DELETE) {
        if (!t.has(op.hex)) continue
        if (snaps !== null) this._record(snaps, t, op.hex, true, old)
        t.remove(op.hex)
        t.dirty.delete(op.hex)
        this._invalidate(t.prefix + op.hex)
      } else {
        const removed = t.range(op.hex, op.endHex)
        if (removed.length === 0) continue
        if (snaps !== null) for (const hex of removed) this._record(snaps, t, hex, true, old)
        t.removeRange(op.hex, op.endHex)
        for (const hex of removed) {
          t.dirty.delete(hex)
          this._invalidate(t.prefix + hex)
        }
      }
    }
  }

  _record(snaps, t, hex, existed, old) {
    let prev
    let have = false
    for (const s of snaps) {
      if (!s.covers(t.name, hex) || s.recorded(t.name, hex)) continue
      if (!have) {
        prev = existed ? this._resident(t, hex, old) : null
        if (prev === undefined) throw new Error('rocksdb-idb: old value missing for a snapshot (' + t.prefix + hex + ')')
        have = true
      }
      s.record(t.name, hex, prev)
    }
  }

  _invalidate(k) {
    this.cache.delete(k)
    const f = this.inflight.get(k)
    if (f !== undefined) f.stale = true
  }

  /**
   * Value of a key as seen by `snap` (null: live): Uint8Array, null (absent), or undefined (in
   * kv only: the caller reads it, in the same tick, with _fetch / _fetchRange).
   */
  _lookup(t, hex, snap) {
    if (snap !== null) {
      const u = snap.undo.get(t.name)
      if (u !== undefined && u.has(hex)) return u.get(hex)
    }
    const d = t.dirty.get(hex)
    if (d !== undefined) return d.value
    if (!t.has(hex)) return null
    const c = this.cache.get(t.prefix + hex)
    if (c !== undefined) {
      this.cacheStats.hits++
      return c
    }
    this.cacheStats.misses++
    return undefined
  }

  /** Reads kv values (one transaction, created now) and caches them unless a write raced. */
  _fetch(keys, cache) {
    const flights = keys.map((k) => {
      let f = this.inflight.get(k)
      if (f === undefined) this.inflight.set(k, (f = { n: 0, stale: false }))
      f.n++
      return f
    })
    const done = () => {
      for (let i = 0; i < keys.length; i++) if (--flights[i].n === 0) this.inflight.delete(keys[i])
    }
    return this.persistence
      .get(keys)
      .then(async (raw) => {
        const values = await Promise.all(raw.map((v, i) => (v === undefined ? Promise.reject(missing(keys[i])) : this._unseal(v, 'value'))))
        if (cache) for (let i = 0; i < keys.length; i++) if (!flights[i].stale) this.cache.set(keys[i], values[i])
        return values
      })
      .finally(done)
  }

  /**
   * Sequential read-ahead: a miss right after the previous one (in key order) grows a window
   * (16 .. 256 keys, at most a quarter of the cache) read with one range request into the cache.
   * Returns { pos, w } (the key's position, the window size), or null for a plain read.
   */
  _readAhead(t, hex) {
    if (this.cache.maxBytes === 0) return null
    const pos = lowerBound(t.keys, hex)
    const ra = t.readAhead || (t.readAhead = { next: -1, streak: 0, size: 0 })
    ra.streak = pos === ra.next ? ra.streak + 1 : 0
    ra.next = pos + 1
    if (ra.streak < 2) return null
    let w = Math.min(256, 8 << Math.min(ra.streak, 5), t.keys.length - pos)
    if (ra.size > 0) w = Math.min(w, Math.floor(this.cache.maxBytes / 4 / ra.size))
    if (w < 2) return null
    ra.next = pos + w
    return { pos, w }
  }

  /** Reads keys[pos, pos + w) with one range request; caches them, returns keys[pos]'s value. */
  _fetchAhead(t, pos, w) {
    const keys = []
    for (let i = pos; i < pos + w; i++) if (i === pos || !t.dirty.has(t.keys[i])) keys.push(t.prefix + t.keys[i])
    const flights = keys.map((k) => {
      let f = this.inflight.get(k)
      if (f === undefined) this.inflight.set(k, (f = { n: 0, stale: false }))
      f.n++
      return f
    })
    const done = () => {
      for (let i = 0; i < keys.length; i++) if (--flights[i].n === 0) this.inflight.delete(keys[i])
    }
    return this.persistence
      .getRange(keys[0], keys[keys.length - 1])
      .then(async (r) => {
        const byKey = new Map()
        for (let i = 0; i < r.keys.length; i++) byKey.set(r.keys[i], r.values[i])
        if (!byKey.has(keys[0])) throw missing(keys[0])
        const values = await Promise.all(keys.map((k) => (byKey.has(k) ? this._unseal(byKey.get(k), 'value') : null)))
        // The first value is the one asked for (always used); the others only if no write raced.
        for (let i = keys.length - 1; i >= 0; i--) if (values[i] !== null && !flights[i].stale) this.cache.set(keys[i], values[i])
        t.readAhead.size = values[0].byteLength || 1
        return values[0]
      })
      .finally(done)
  }

  /** Values of `keys` (sorted kv keys) through one range request over [first, last]. */
  async _fetchRange(keys) {
    const lo = keys[0] < keys[keys.length - 1] ? keys[0] : keys[keys.length - 1]
    const hi = lo === keys[0] ? keys[keys.length - 1] : keys[0]
    const r = await this.persistence.getRange(lo, hi)
    const byKey = new Map()
    for (let i = 0; i < r.keys.length; i++) byKey.set(r.keys[i], r.values[i])
    return Promise.all(
      keys.map((k) => {
        const v = byKey.get(k)
        return v === undefined ? Promise.reject(missing(k)) : this._unseal(v, 'value')
      })
    )
  }

  /** Waits for pending commits, then compacts the WAL into kv. */
  async flush() {
    if (this.persistence === null) return
    if (!this.opened) await this.ready()
    if (this.error !== null) throw this._readOnlyError()
    this.compactRequested = true
    this._kick()
    while (this.writing !== null) await this.writing
    if (this.error !== null) throw this._readOnlyError()
  }

  async _compact() {
    this.compactRequested = false
    clearTimeout(this.compactTimer)
    this.compactTimer = null
    const recs = this.unflushed.slice()
    const upTo = recs[recs.length - 1].seq
    // Coalesce: last write per key wins; a range delete drops earlier writes inside it and is
    // applied before every single-key write (they all come later or are outside of it).
    const ranges = []
    const writes = new Map() // kv key -> value | null
    for (const rec of recs) {
      for (const op of rec.ops) {
        const p = op.table.prefix
        if (op.type === PUT) writes.set(p + op.hex, op.value)
        else if (op.type === DELETE) writes.set(p + op.hex, null)
        else if (op.hex < op.endHex) {
          const s = p + op.hex
          const e = p + op.endHex
          ranges.push([s, e])
          for (const k of writes.keys()) if (k >= s && k < e) writes.delete(k)
        }
      }
    }
    let entries = [...writes]
    try {
      if (this.cipher !== null) {
        const sealed = await Promise.all(entries.map(([, v]) => (v === null ? null : this._seal(v))))
        entries = entries.map(([k], i) => [k, sealed[i]])
      }
      await this.persistence.compact(upTo, recs.length, ranges, entries)
    } catch (e) {
      this._fail(storageError(e, 'compaction')) // the WAL still holds everything: nothing is lost
      return
    }
    // Unpin: values now in kv move to the cache (unless overwritten by a later record).
    this.unflushed.splice(0, recs.length)
    for (const rec of recs) {
      this.walBytes -= rec.bytes
      for (const op of rec.ops) {
        if (op.type !== PUT) continue
        const d = op.table.dirty.get(op.hex)
        if (d === undefined || d.seq !== rec.seq || d.value !== op.value) continue
        op.table.dirty.delete(op.hex)
        this.cache.set(op.table.prefix + op.hex, d.value)
      }
    }
  }

  pinnedBytes() {
    let n = 0
    for (const t of this.tables.values()) for (const d of t.dirty.values()) n += d.value.byteLength
    return n
  }
}

function missing(k) {
  return new RocksDBIDBError('Value missing in IndexedDB for key ' + k + ' (database modified outside rocksdb-idb?)', 'IDB_ERROR')
}

function copy(buf) {
  const out = b4a.allocUnsafe(buf.byteLength)
  out.set(buf)
  return out
}

class Batch {
  constructor(db, opts = {}) {
    const { autoDestroy = false } = opts
    db._ref()
    this._db = db
    this._autoDestroy = autoDestroy
    this._destroyed = false
    this._request = null
    this._operations = []
    this._promises = []
  }

  async ready() {
    if (!this._db._state.opened) await this._db._state.ready()
  }

  destroy() {
    if (this._request) throw new Error('Request in progress')
    if (this._destroyed) return
    this._destroyed = true
    if (this._promises.length) this._abort(new Error('Batch is destroyed'))
    this._db._unref()
  }

  _abort(err) {
    for (const p of this._promises) if (p !== null) p.reject(err)
    this._operations = []
    this._promises = []
  }

  flush() {
    if (this._request) throw new Error('Request in progress')
    if (this._destroyed) throw new Error('Batch is destroyed')
    this._request = this._flush()
    return this._request
  }

  tryFlush() {
    this.flush().catch(noop)
  }

  async _flush() {
    const operations = this._operations
    const promises = this._promises
    this._operations = []
    this._promises = []
    let err = null
    try {
      if (!this._db._state.opened) await this._db._state.ready()
      await this._run(operations, promises)
    } catch (e) {
      err = e
      for (const p of promises) if (p !== null) p.reject(e)
    }
    this._request = null
    if (this._autoDestroy) this.destroy()
    if (err) throw err
  }

  _encodeKey(k) {
    const enc = this._db._keyEncoding
    if (enc) return encode(enc, k)
    if (typeof k === 'string') return b4a.from(k)
    return k
  }

  _encodeValue(v) {
    const enc = this._db._valueEncoding
    if (enc) return encode(enc, v)
    if (v === null || v === undefined) return EMPTY
    if (typeof v === 'string') return b4a.from(v)
    return v
  }

  _decodeValue(b) {
    const enc = this._db._valueEncoding
    return enc ? decode(enc, b) : b
  }

  _enqueue(op, withPromise) {
    if (this._request) throw new Error('Request already in progress')
    this._operations.push(op)
    if (!withPromise) {
      this._promises.push(null)
      return
    }
    return new Promise((resolve, reject) => this._promises.push({ resolve, reject }))
  }
}

class ReadBatch extends Batch {
  get(key) {
    this._db._state.stats.gets++
    return this._enqueue({ type: GET, key: this._encodeKey(key), cf: this._db._columnFamily }, true)
  }

  async _run(operations, promises) {
    const db = this._db
    const state = db._state
    state.stats.readBatches++
    const snap = db._snapshot
    const values = new Array(operations.length)
    const miss = []
    const missAt = []
    let lastTable = null
    let lastHex = null
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i]
      const t = state.table(op.cf)
      const hex = b4a.toString(op.key, 'hex')
      const v = state._lookup(t, hex, snap)
      if (v === undefined) {
        miss.push(t.prefix + hex)
        missAt.push(i)
        lastTable = t
        lastHex = hex
      } else {
        values[i] = v
      }
    }
    // All lookups and the IndexedDB request happen in this tick (see _lookup).
    const ahead = miss.length === 1 ? state._readAhead(lastTable, lastHex) : null
    if (ahead !== null) {
      values[missAt[0]] = await state._fetchAhead(lastTable, ahead.pos, ahead.w)
    } else if (miss.length > 0) {
      const got = await state._fetch(miss, true)
      for (let j = 0; j < got.length; j++) values[missAt[j]] = got[j]
    }
    for (let i = 0; i < operations.length; i++) {
      const p = promises[i]
      if (p !== null) p.resolve(values[i] ? this._decodeValue(copy(values[i])) : null)
    }
  }
}

class WriteBatch extends Batch {
  put(key, value) {
    this._db._state.stats.puts++
    return this._enqueue({ type: PUT, key: this._encodeKey(key), value: this._encodeValue(value), cf: this._db._columnFamily }, true)
  }

  tryPut(key, value) {
    this._db._state.stats.puts++
    this._enqueue({ type: PUT, key: this._encodeKey(key), value: this._encodeValue(value), cf: this._db._columnFamily }, false)
  }

  delete(key) {
    this._db._state.stats.deletes++
    return this._enqueue({ type: DELETE, key: this._encodeKey(key), cf: this._db._columnFamily }, true)
  }

  tryDelete(key) {
    this._db._state.stats.deletes++
    this._enqueue({ type: DELETE, key: this._encodeKey(key), cf: this._db._columnFamily }, false)
  }

  deleteRange(start, end) {
    this._db._state.stats.rangeDeletes++
    return this._enqueue({ type: DELETE_RANGE, key: this._encodeKey(start), end: this._encodeKey(end), cf: this._db._columnFamily }, true)
  }

  tryDeleteRange(start, end) {
    this._db._state.stats.rangeDeletes++
    this._enqueue({ type: DELETE_RANGE, key: this._encodeKey(start), end: this._encodeKey(end), cf: this._db._columnFamily }, false)
  }

  async _run(operations, promises) {
    const state = this._db._state
    if (state.closing) throw new Error('RocksDB session is closed')
    state.stats.writeBatches++
    if (operations.length > 0) await state.write(operations)
    for (const p of promises) if (p !== null) p.resolve()
  }
}

class Iterator extends Readable {
  constructor(db, opts = {}) {
    const { gt = null, gte = null, lt = null, lte = null, reverse = false, values = true, limit = Infinity, capacity = 8 } = opts
    super()
    db._ref()
    this._db = db
    this._bounds = {
      gt: gt ? this._hex(gt) : null,
      gte: gte ? this._hex(gte) : null,
      lt: lt ? this._hex(lt) : null,
      lte: lte ? this._hex(lte) : null
    }
    this._reverse = reverse
    this._values = values
    this._limit = limit < 0 ? Infinity : limit
    // Keys per read: their missing values come in one IndexedDB request.
    this._chunk = Math.max(32, capacity)
    this._snap = null
    this._table = null
    this._last = null
  }

  _hex(k) {
    const enc = this._db._keyEncoding
    const buf = enc ? encode(enc, k) : typeof k === 'string' ? b4a.from(k) : k
    return b4a.toString(buf, 'hex')
  }

  async _open(cb) {
    const state = this._db._state
    if (!state.opened) {
      try {
        await state.ready()
      } catch (err) {
        return cb(err)
      }
    }
    if (state.closing) return cb(new Error('RocksDB session is closed'))
    this._table = state.table(this._db._columnFamily)
    // Implicit snapshot, as a RocksDB iterator: writes made while iterating are not seen. Scoped
    // to the range so that writes elsewhere cost nothing.
    this._snap = this._db._snapshot || new Snapshot(state, { cf: this._table.name, b: this._bounds })
    this._snap.ref()
    cb(null)
  }

  /** Next key present in the snapshot, or null. */
  _nextKey() {
    const t = this._table
    const b = this._bounds
    const rev = this._reverse
    const undo = this._snap.undoKeys(t.name)
    const undoMap = undo === null ? null : this._snap.undo.get(t.name)
    let after = this._last
    while (true) {
      const a = t.next(after, b, rev)
      const u = undo !== null ? nextInSorted(undo, after, b, rev) : null
      let k
      if (a === null) k = u
      else if (u === null) k = a
      else k = rev ? (a > u ? a : u) : a < u ? a : u
      if (k === null) return null
      after = k
      // Not in the undo log: unchanged since the snapshot, and it came from the live index.
      if (undoMap !== null && undoMap.has(k) && undoMap.get(k) === null) continue
      this._last = k
      return k
    }
  }

  _read(cb) {
    this._fill().then(() => cb(null), cb)
  }

  async _fill() {
    const want = Math.min(this._chunk, this._limit)
    const keys = []
    while (keys.length < want) {
      const k = this._nextKey()
      if (k === null) break
      keys.push(k)
    }
    const values = this._values && keys.length > 0 ? await this._resolve(keys) : null
    for (let i = 0; i < keys.length; i++) {
      this.push({ key: this._decodeKey(b4a.from(keys[i], 'hex')), value: values !== null ? this._decodeValue(copy(values[i])) : null })
    }
    this._limit -= keys.length
    if (keys.length < want || this._limit <= 0) this.push(null)
  }

  async _resolve(keys) {
    const state = this._db._state
    const t = this._table
    const values = new Array(keys.length)
    const miss = []
    for (let i = 0; i < keys.length; i++) {
      const v = state._lookup(t, keys[i], this._snap)
      if (v === undefined) miss.push(i)
      else values[i] = v
    }
    if (miss.length === 0) return values
    const fks = miss.map((i) => t.prefix + keys[i])
    // Mostly misses: one range request (getAll). A few: point reads (one transaction).
    const got = miss.length >= 4 && miss.length * 2 >= keys.length ? await state._fetchRange(fks) : await state._fetch(fks, false)
    for (let j = 0; j < miss.length; j++) values[miss[j]] = got[j]
    return values
  }

  _destroy(cb) {
    if (this._snap) this._snap.unref()
    this._snap = null
    this._db._unref()
    cb(null)
  }

  _decodeKey(b) {
    const enc = this._db._keyEncoding
    return enc ? decode(enc, b) : b
  }

  _decodeValue(b) {
    const enc = this._db._valueEncoding
    return enc ? decode(enc, b) : b
  }
}

class RocksDB {
  constructor(path, opts = {}) {
    const { columnFamily, state = new State(this, path, opts), snapshot = null, keyEncoding = null, valueEncoding = null } = opts
    this._state = state
    this._snapshot = snapshot
    this._columnFamily = state.getColumnFamily(columnFamily)
    this._keyEncoding = keyEncoding
    this._valueEncoding = valueEncoding
    this._index = -1
    this._state.addSession(this)
  }

  get opened() {
    return this._state.opened
  }

  get closed() {
    return this.isRoot() ? this._state.closed : this._index === -1
  }

  get path() {
    return this._state.path
  }

  get stats() {
    return this._state.stats
  }

  get snapshotted() {
    return this._snapshot !== null
  }

  get defaultColumnFamily() {
    return this._columnFamily
  }

  /** The storage error that made the database read-only (null when healthy). */
  get storageError() {
    return this._state.error
  }

  /** Persistence and cache counters; null in memory mode. */
  get persistenceStats() {
    const s = this._state
    if (s.persistence === null) return null
    let keys = 0
    for (const t of s.tables.values()) keys += t.keys.length
    return {
      ...s.persistence.stats,
      walPending: s.unflushed.length,
      walPendingBytes: s.walBytes,
      keys,
      pinnedBytes: s.pinnedBytes(),
      cacheBytes: s.cache.bytes,
      cacheEntries: s.cache.size,
      cacheHits: s.cacheStats.hits,
      cacheMisses: s.cacheStats.misses,
      error: s.error ? s.error.code : null
    }
  }

  session({ columnFamily = this._columnFamily, snapshot = this._snapshot !== null, keyEncoding = this._keyEncoding, valueEncoding = this._valueEncoding } = {}) {
    maybeClosed(this)
    return new RocksDB(null, {
      state: this._state,
      columnFamily,
      snapshot: snapshot ? this._snapshot || new Snapshot(this._state) : null,
      keyEncoding,
      valueEncoding
    })
  }

  columnFamily(name, opts) {
    return this.session({ ...opts, columnFamily: name })
  }

  snapshot() {
    return this.session({ snapshot: true })
  }

  isRoot() {
    return this === this._state.db
  }

  ready() {
    return this._state.ready()
  }

  async close({ force } = {}) {
    if (!this._state.opened) await this._state.ready().catch(noop)
    if (this._index !== -1) this._state.removeSession(this)
    if (force) {
      while (this._state.sessions.length > 0) await this._state.sessions[this._state.sessions.length - 1].close()
    }
    return this.isRoot() ? this._state.close() : undefined
  }

  async suspend() {
    maybeClosed(this)
    this._state.suspended = true
    await this._state.flush()
  }

  async resume() {
    maybeClosed(this)
    this._state.suspended = false
  }

  isIdle() {
    return this._state.handles === 0
  }

  async idle() {
    while (this._state.handles !== 0) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  iterator(range, opts) {
    maybeClosed(this)
    return new Iterator(this, { ...range, ...opts })
  }

  async *keys(range, opts) {
    for await (const { key } of this.iterator(range, { ...opts, values: false })) yield key
  }

  async peek(range, opts) {
    for await (const value of this.iterator({ ...range, ...opts, limit: 1 })) return value
    return null
  }

  read(opts) {
    maybeClosed(this)
    return new ReadBatch(this, opts)
  }

  write(opts) {
    maybeClosed(this)
    return new WriteBatch(this, opts)
  }

  /** Waits for every pending write batch to be durable and compacts the WAL. */
  flush() {
    maybeClosed(this)
    return this._state.flush()
  }

  async get(key, opts) {
    const batch = this.read({ ...opts, autoDestroy: true })
    const value = batch.get(key)
    batch.tryFlush()
    return value
  }

  async put(key, value, opts) {
    const batch = this.write({ ...opts, autoDestroy: true })
    batch.tryPut(key, value)
    await batch.flush()
  }

  async delete(key, opts) {
    const batch = this.write({ ...opts, autoDestroy: true })
    batch.tryDelete(key)
    await batch.flush()
  }

  async deleteRange(start, end, opts) {
    const batch = this.write({ ...opts, autoDestroy: true })
    batch.tryDeleteRange(start, end)
    await batch.flush()
  }

  /** Compacts the WAL into kv (the range is ignored: there are no SST files here). */
  compact() {
    return this._state.flush()
  }

  compactRange() {
    return this._state.flush()
  }

  async approximateSize() {
    return 0
  }

  _ref() {
    if (this._snapshot) this._snapshot.ref()
    this._state.handles++
  }

  _unref() {
    if (this._snapshot) this._snapshot.unref()
    this._state.handles--
  }

  /** Deletes the IndexedDB database behind `name` (the db must be closed). */
  static destroy(name, { indexedDB = globalThis.indexedDB } = {}) {
    return IDBPersistence.destroy(name, { indexedDB })
  }
}

function maybeClosed(db) {
  if (db._state.closing || db._index === -1) throw new Error('RocksDB session is closed')
}

let cenc = null
function encode(enc, v) {
  if (cenc === null) cenc = require('compact-encoding')
  return cenc.encode(enc, v)
}
function decode(enc, b) {
  if (cenc === null) cenc = require('compact-encoding')
  return cenc.decode(enc, b)
}

function noop() {}

module.exports = exports = RocksDB
exports.ColumnFamily = ColumnFamily
exports.RocksDB = RocksDB
exports.RocksDBIDBError = RocksDBIDBError
exports.aesGcmCipher = aesGcmCipher
exports.storageEstimate = storageEstimate
exports.requestPersist = requestPersist
// rocksdb-native's filter policies are accepted and ignored (no SST files here).
exports.BloomFilterPolicy = class BloomFilterPolicy {
  constructor(bits) {
    this.bits = bits
  }
}
exports.RibbonFilterPolicy = class RibbonFilterPolicy {
  constructor(bits) {
    this.bits = bits
  }
}
exports.constants = { walRecoveryMode: {}, statsLevel: {} }
