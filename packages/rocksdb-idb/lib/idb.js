// IndexedDB layout (schema version 2):
//   kv    string keys `<columnFamily>/<hexKey>` (byte order preserved, so a RocksDB deleteRange is
//         an IDBKeyRange delete), Uint8Array values (sealed by the cipher when there is one)
//   wal   integer keys (sequence), one record per group commit (lib/codec.js, sealed)
//   meta  'cipher' -> the sealed magic, present iff the database is encrypted
// Version 1 (spike) had only `kv`: the upgrade adds `wal` and `meta`, data is kept as is.
//
// This module only moves bytes; ordering, the commit pipeline and caching are in index.js.
// Reads create their transaction synchronously, so a read sees `kv` as it was when it was issued
// (IndexedDB orders transactions with overlapping scopes by creation).

const { storageError } = require('./errors')

const KV = 'kv'
const WAL = 'wal'
const META = 'meta'
const VERSION = 2
const SEP = '/'

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = (e) => {
      if (e && e.preventDefault) e.preventDefault()
      reject(req.error)
    }
  })
}

class IDBPersistence {
  constructor(name, { indexedDB, IDBKeyRange, durability = 'relaxed', onlost = null } = {}) {
    this.name = name
    this.idb = indexedDB
    this.KeyRange = IDBKeyRange
    this.durability = durability
    this.onlost = onlost
    this.db = null
    this.stats = { transactions: 0, batches: 0, ops: 0, walRecords: 0, walBytes: 0, compactions: 0, compactedRecords: 0, reads: 0, readKeys: 0, replayed: 0 }
  }

  static key(cf, hex) {
    return cf + SEP + hex
  }

  static split(k) {
    const i = k.indexOf(SEP)
    return [k.slice(0, i), k.slice(i + 1)]
  }

  /** Opens (creating / upgrading) and returns { keys (kv keys, sorted), wal: [[seq, bytes]], cipher }. */
  async open() {
    try {
      const req = this.idb.open(this.name, VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV)
        if (!db.objectStoreNames.contains(WAL)) db.createObjectStore(WAL)
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META)
      }
      this.db = await reqP(req)
    } catch (err) {
      throw storageError(err, 'open')
    }
    const db = this.db
    // Another context upgrading / deleting this database, or the browser closing the connection
    // (storage cleared, disk error): from then on writes fail; report it.
    db.onversionchange = () => {
      db.close()
      if (this.onlost) this.onlost(storageError(new Error('database deleted or upgraded by another context'), 'connection'))
    }
    db.onclose = () => {
      if (this.onlost) this.onlost(storageError(new Error('connection closed by the browser'), 'connection'))
    }
    try {
      const tx = db.transaction([KV, WAL, META], 'readonly')
      const kv = tx.objectStore(KV)
      const wal = tx.objectStore(WAL)
      const [keys, walKeys, walValues, cipher] = await Promise.all([
        reqP(kv.getAllKeys()),
        reqP(wal.getAllKeys()),
        reqP(wal.getAll()),
        reqP(tx.objectStore(META).get('cipher'))
      ])
      return { keys, wal: walKeys.map((k, i) => [k, walValues[i]]), cipher }
    } catch (err) {
      throw storageError(err, 'load')
    }
  }

  _tx(stores, mode) {
    try {
      return this.db.transaction(stores, mode, { durability: this.durability })
    } catch {
      return this.db.transaction(stores, mode)
    }
  }

  /** Runs fn(tx) in a readwrite transaction; resolves on commit, rejects (coded) on abort. */
  _write(stores, what, fn) {
    return new Promise((resolve, reject) => {
      let tx
      let first = null
      try {
        if (this.db === null) throw new Error('database is closed')
        tx = this._tx(stores, 'readwrite')
      } catch (err) {
        reject(storageError(err, what))
        return
      }
      tx.oncomplete = () => resolve()
      tx.onerror = (e) => {
        if (first === null && e && e.target) first = e.target.error
      }
      tx.onabort = () => reject(storageError(tx.error || first || new Error('transaction aborted'), what))
      this.stats.transactions++
      try {
        fn(tx)
      } catch (err) {
        first = first || err
        try {
          tx.abort()
        } catch {}
      }
    })
  }

  putMeta(key, value) {
    return this._write([META], 'meta write', (tx) => tx.objectStore(META).put(value, key))
  }

  /** Appends one WAL record (one group commit). */
  appendWal(seq, bytes, batches, ops) {
    this.stats.batches += batches
    this.stats.ops += ops
    this.stats.walRecords++
    this.stats.walBytes += bytes.byteLength
    return this._write([WAL], 'WAL commit', (tx) => tx.objectStore(WAL).put(bytes, seq))
  }

  /**
   * Applies coalesced WAL records into kv and deletes them, in one transaction.
   * ranges: [[startKey, endKey)], entries: [[key, value | null]] (applied after the ranges).
   */
  compact(upTo, records, ranges, entries) {
    this.stats.compactions++
    this.stats.compactedRecords += records
    return this._write([KV, WAL], 'compaction', (tx) => {
      const kv = tx.objectStore(KV)
      for (const [s, e] of ranges) kv.delete(this.KeyRange.bound(s, e, false, true))
      for (const [k, v] of entries) {
        if (v === null) kv.delete(k)
        else kv.put(v, k)
      }
      tx.objectStore(WAL).delete(this.KeyRange.upperBound(upTo))
    })
  }

  _read(what, fn) {
    let tx
    try {
      if (this.db === null) throw new Error('database is closed')
      tx = this.db.transaction(KV, 'readonly')
    } catch (err) {
      return Promise.reject(storageError(err, what))
    }
    this.stats.reads++
    return fn(tx.objectStore(KV)).catch((err) => {
      throw storageError(err, what)
    })
  }

  /** Values of `keys` (undefined when missing), one transaction. */
  get(keys) {
    this.stats.readKeys += keys.length
    return this._read('read', (store) => Promise.all(keys.map((k) => reqP(store.get(k)))))
  }

  /** Every [key, value] in [lo, hi] (inclusive), one transaction. */
  getRange(lo, hi) {
    return this._read('range read', (store) => {
      const range = this.KeyRange.bound(lo, hi)
      return Promise.all([reqP(store.getAllKeys(range)), reqP(store.getAll(range))]).then(([keys, values]) => {
        this.stats.readKeys += keys.length
        return { keys, values }
      })
    })
  }

  close() {
    if (this.db === null) return
    this.db.onclose = null
    this.db.onversionchange = null
    this.db.close()
    this.db = null
  }

  static async destroy(name, { indexedDB }) {
    await reqP(indexedDB.deleteDatabase(name))
  }
}

module.exports = { IDBPersistence, VERSION }
