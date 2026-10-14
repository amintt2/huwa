// rocksdb-idb: the subset of rocksdb-native (3.x) that hypercore-storage (3.x) uses, for browsers.
//
// Data lives in memory (one sorted table per column family, see lib/table.js) and is persisted to
// IndexedDB (lib/idb.js). Covered surface, mirroring rocksdb-native's JS API and the private fields
// hypercore-storage reads (`_snapshot`, `_state.closing`, `_index`):
//   new RocksDB(path, opts) · ready · close · suspend · resume · flush · compactRange (no-op)
//   session({ columnFamily, snapshot }) · columnFamily(cf) · snapshot() · snapshotted · path
//   read() -> ReadBatch { get, flush, tryFlush, destroy }
//   write() -> WriteBatch { put, tryPut, delete, tryDelete, deleteRange, tryDeleteRange, flush, tryFlush, destroy }
//   get / put / delete / deleteRange / peek / keys · iterator({ gt, gte, lt, lte, reverse, limit, values })
//   RocksDB.ColumnFamily
// Semantics: write batches are atomic; snapshots are MVCC (undo log per live snapshot); every
// iterator reads from a snapshot taken when it opens (explicit, or implicit like RocksDB).
//
// Options: { indexedDB, IDBKeyRange } (default: globalThis's; pass null for memory only),
// { durability: 'relaxed' | 'strict' | 'default' }, { keyEncoding, valueEncoding } (compact-encoding).
const { Readable } = require('streamx')
const b4a = require('b4a')
const { Table, nextInSorted } = require('./lib/table')
const { IDBPersistence } = require('./lib/idb')

const EMPTY = b4a.alloc(0)

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
  constructor(state) {
    this.state = state
    this.undo = new Map() // cf -> Map(hex -> entry | null): values as of the snapshot
    this.sorted = new Map() // cf -> { size, keys } sorted undo keys, rebuilt when the undo grows
    this.refs = 0
    state.snapshots.add(this)
  }

  record(cf, hex, prev) {
    let m = this.undo.get(cf)
    if (!m) {
      m = new Map()
      this.undo.set(cf, m)
    }
    if (!m.has(hex)) m.set(hex, prev)
  }

  lookup(table, hex) {
    const m = this.undo.get(table.name)
    if (m && m.has(hex)) return m.get(hex)
    return table.get(hex)
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
    this.persistence = idb ? new IDBPersistence(opts.name || path, { indexedDB: idb, IDBKeyRange: KeyRange, durability: opts.durability }) : null

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
    let t = this.tables.get(cf.name)
    if (!t) {
      t = new Table(cf.name)
      this.tables.set(cf.name, t)
    }
    return t
  }

  ready() {
    if (this._opening === null) this._opening = this._open()
    return this._opening
  }

  async _open() {
    if (this.persistence) {
      const { keys, values } = await this.persistence.open()
      for (let i = 0; i < keys.length; i++) {
        const [cf, hex] = IDBPersistence.split(keys[i])
        let t = this.tables.get(cf)
        if (!t) {
          t = new Table(cf)
          this.tables.set(cf, t)
        }
        const v = values[i]
        t.load(hex, { key: b4a.from(hex, 'hex'), value: v instanceof Uint8Array ? v : new Uint8Array(v) })
      }
    }
    this.opened = true
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
    await this.ready().catch(() => {})
    if (this.persistence) await this.persistence.close()
    this.closed = true
  }

  _record(cf, hex, prev) {
    for (const s of this.snapshots) s.record(cf, hex, prev)
  }

  /** Applies a write batch to memory (atomically: synchronous) and persists it. */
  apply(operations) {
    const ops = this.persistence ? [] : null
    for (const op of operations) {
      const t = this.table(op.cf)
      if (op.type === PUT) {
        const hex = b4a.toString(op.key, 'hex')
        const entry = { key: copy(op.key), value: copy(op.value) }
        this._record(t.name, hex, t.put(hex, entry))
        if (ops) ops.push(['p', IDBPersistence.key(t.name, hex), entry.value])
      } else if (op.type === DELETE) {
        const hex = b4a.toString(op.key, 'hex')
        const prev = t.delete(hex)
        if (prev) this._record(t.name, hex, prev)
        if (ops) ops.push(['d', IDBPersistence.key(t.name, hex)])
      } else {
        const start = b4a.toString(op.key, 'hex')
        const end = b4a.toString(op.end, 'hex')
        for (const [hex, prev] of t.deleteRange(start, end)) this._record(t.name, hex, prev)
        if (ops && start < end) ops.push(['r', IDBPersistence.key(t.name, start), IDBPersistence.key(t.name, end)])
      }
    }
    if (!ops || !ops.length) return Promise.resolve()
    return this.persistence.enqueue(ops)
  }

  flush() {
    return this.persistence ? this.persistence.flush() : Promise.resolve()
  }
}

const GET = 0
const PUT = 1
const DELETE = 2
const DELETE_RANGE = 3

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
    if (!this._db._state.opened) await this._db._state.ready()
    const operations = this._operations
    const promises = this._promises
    this._operations = []
    this._promises = []
    let err = null
    try {
      await this._run(operations, promises)
    } catch (e) {
      err = e
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
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i]
      const t = state.table(op.cf)
      const hex = b4a.toString(op.key, 'hex')
      const e = snap ? snap.lookup(t, hex) : t.get(hex)
      const p = promises[i]
      if (p !== null) p.resolve(e ? this._decodeValue(copy(e.value)) : null)
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
    let err = null
    try {
      await state.apply(operations)
    } catch (e) {
      err = e
    }
    for (const p of promises) {
      if (p === null) continue
      if (err) p.reject(err)
      else p.resolve()
    }
    if (err) throw new Error('Batch was not applied', { cause: err })
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
    this._capacity = Math.max(1, capacity)
    this._snap = null
    this._ownSnap = false
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
    if (!state.opened) await state.ready()
    if (state.closing) return cb(new Error('RocksDB session is closed'))
    this._table = state.table(this._db._columnFamily)
    if (this._db._snapshot) {
      this._snap = this._db._snapshot
    } else {
      // Implicit snapshot, as a RocksDB iterator: writes made while iterating are not seen.
      this._snap = new Snapshot(state)
      this._ownSnap = true
    }
    this._snap.ref()
    cb(null)
  }

  _next() {
    const t = this._table
    const b = this._bounds
    const rev = this._reverse
    const undo = this._snap.undoKeys(t.name)
    let after = this._last
    while (true) {
      const a = t.next(after, b, rev)
      const u = undo ? nextInSorted(undo, after, b, rev) : null
      let k
      if (a === null) k = u
      else if (u === null) k = a
      else k = rev ? (a > u ? a : u) : a < u ? a : u
      if (k === null) return null
      after = k
      const e = this._snap.lookup(t, k)
      if (e) {
        this._last = k
        return e
      }
    }
  }

  _read(cb) {
    let n = 0
    const want = Math.min(this._capacity, this._limit)
    while (n < want) {
      const e = this._next()
      if (e === null) {
        this.push(null)
        return cb(null)
      }
      n++
      this._limit--
      this.push({ key: this._decodeKey(copy(e.key)), value: this._values ? this._decodeValue(copy(e.value)) : null })
    }
    if (this._limit <= 0) this.push(null)
    cb(null)
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

  /** Persistence counters (IndexedDB transactions, batches, ops); null in memory mode. */
  get persistenceStats() {
    return this._state.persistence ? this._state.persistence.stats : null
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

  async compact() {}

  async compactRange() {}

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
