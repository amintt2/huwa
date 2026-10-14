// Test helpers: crash simulation, IndexedDB fault injection, raw store dumps, fake Web Locks.
import b4a from 'b4a'
import RocksDB from '../index.js'

export const s = (b) => (b ? b4a.toString(b) : b)

export async function all(it) {
  const out = []
  for await (const e of it) out.push([s(e.key), s(e.value)])
  return out
}

/** "Crash": drop the instance without flushing, compacting or closing cleanly. */
export function kill(db) {
  const st = db._state
  st._fail(Object.assign(new Error('killed'), { code: 'KILLED' })) // rejects what waits
  clearTimeout(st.compactTimer)
  st.compactTimer = null
  if (st.persistence) st.persistence.close()
  st._unlock()
}

/**
 * Makes IndexedDB writes (put / delete) on `store` fail from the `at`-th one on (1-based):
 * mode 'quota' throws a QuotaExceededError, 'abort' aborts the transaction after the request.
 * Returns restore().
 */
export function inject({ store, mode = 'quota', at = 1, onHit = null }) {
  const proto = globalThis.IDBObjectStore.prototype
  const orig = { put: proto.put, delete: proto.delete }
  let count = 0
  for (const m of ['put', 'delete']) {
    proto[m] = function (...args) {
      if (store === '*' || this.name === store) {
        if (++count >= at) {
          if (onHit) onHit(this.name, m, count)
          if (mode === 'quota') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
          const req = orig[m].apply(this, args)
          this.transaction.abort()
          return req
        }
      }
      return orig[m].apply(this, args)
    }
  }
  return () => {
    proto.put = orig.put
    proto.delete = orig.delete
  }
}

function dump(nm, store) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(nm)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(store, 'readonly')
      const keys = tx.objectStore(store).getAllKeys()
      const values = tx.objectStore(store).getAll()
      tx.oncomplete = () => {
        db.close()
        resolve(keys.result.map((k, i) => [k, values.result[i]]))
      }
      tx.onerror = () => reject(tx.error)
    }
  })
}

export const rawKV = (nm) => dump(nm, 'kv')
export const rawWAL = (nm) => dump(nm, 'wal')

/** Minimal LockManager: request(name, { ifAvailable }, cb), exclusive locks only. */
export function fakeLocks() {
  const held = new Set()
  return {
    held: () => [...held],
    async request(name, opts, cb) {
      if (held.has(name)) {
        if (opts.ifAvailable) return cb(null)
        throw new Error('fakeLocks: waiting is not implemented')
      }
      held.add(name)
      try {
        return await cb({ name, mode: 'exclusive' })
      } finally {
        held.delete(name)
      }
    }
  }
}

export async function randomCipher() {
  const key = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  return { key, cipher: RocksDB.aesGcmCipher(key) }
}
