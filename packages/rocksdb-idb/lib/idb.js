// IndexedDB persistence: one object store `kv`, string keys `<columnFamily>/<hexKey>` (byte order
// preserved, so a RocksDB deleteRange is an IDBKeyRange delete), Uint8Array values.
//
// Write batches are group-committed: everything flushed while a transaction is in flight goes into
// the next one, and each batch's promise resolves when the transaction holding it completes. A
// transaction is atomic, and it always holds whole batches, so a batch is all-or-nothing on disk.
// No separate WAL: IndexedDB already is the log (the browser's LevelDB / SQLite underneath).

const STORE = 'kv'
const SEP = '/'

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

class IDBPersistence {
  constructor(name, { indexedDB, IDBKeyRange, durability = 'relaxed' } = {}) {
    this.name = name
    this.idb = indexedDB
    this.KeyRange = IDBKeyRange
    this.durability = durability
    this.db = null
    this.pending = []
    this.committing = null
    this.error = null
    this.stats = { transactions: 0, batches: 0, ops: 0 }
  }

  static key(cf, hex) {
    return cf + SEP + hex
  }

  static split(k) {
    const i = k.indexOf(SEP)
    return [k.slice(0, i), k.slice(i + 1)]
  }

  async open() {
    const req = this.idb.open(this.name, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    this.db = await reqP(req)
    // Another context (tab, worker) upgrading or deleting this database: let it go.
    this.db.onversionchange = () => this.db.close()
    const tx = this.db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const [keys, values] = await Promise.all([reqP(store.getAllKeys()), reqP(store.getAll())])
    return { keys, values }
  }

  /** ops: ['p', key, value] | ['d', key] | ['r', startKey, endKey]. Resolves once committed. */
  enqueue(ops) {
    if (this.error) return Promise.reject(this.error)
    return new Promise((resolve, reject) => {
      this.pending.push({ ops, resolve, reject })
      if (this.committing === null) this.committing = this._commitLoop()
    })
  }

  async _commitLoop() {
    // Let the current tick add its batches to the same transaction.
    await Promise.resolve()
    try {
      while (this.pending.length) {
        const group = this.pending
        this.pending = []
        try {
          await this._commit(group)
          for (const g of group) g.resolve()
        } catch (err) {
          this.error = err
          for (const g of group) g.reject(err)
          for (const g of this.pending) g.reject(err)
          this.pending = []
        }
      }
    } finally {
      this.committing = null
    }
  }

  _commit(group) {
    return new Promise((resolve, reject) => {
      let tx
      try {
        tx = this.db.transaction(STORE, 'readwrite', { durability: this.durability })
      } catch {
        tx = this.db.transaction(STORE, 'readwrite')
      }
      const store = tx.objectStore(STORE)
      let n = 0
      for (const { ops } of group) {
        for (const op of ops) {
          n++
          if (op[0] === 'p') store.put(op[2], op[1])
          else if (op[0] === 'd') store.delete(op[1])
          else store.delete(this.KeyRange.bound(op[1], op[2], false, true))
        }
      }
      this.stats.transactions++
      this.stats.batches += group.length
      this.stats.ops += n
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'))
    })
  }

  async flush() {
    while (this.committing !== null) await this.committing
    if (this.error) throw this.error
  }

  async close() {
    await this.flush().catch(() => {})
    if (this.db) this.db.close()
    this.db = null
  }

  static async destroy(name, { indexedDB }) {
    await reqP(indexedDB.deleteDatabase(name))
  }
}

module.exports = { IDBPersistence }
