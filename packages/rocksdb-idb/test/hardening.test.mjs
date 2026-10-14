// Production hardening of rocksdb-idb (fake-indexeddb): lazy values + LRU, WAL + compaction,
// v1 migration, storage errors, cipher, single-writer lock, storage helpers.
import test from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import b4a from 'b4a'
import RocksDB from '../index.js'
import { kill, inject, rawKV, rawWAL, fakeLocks, randomCipher, s, all } from './helpers.mjs'

let n = 0
const name = () => 'hard-' + process.pid + '-' + n++

async function fill(db, count, size = 1024, prefix = 'k') {
  const w = db.write()
  for (let i = 0; i < count; i++) w.tryPut(prefix + String(i).padStart(6, '0'), b4a.alloc(size, i % 251))
  await w.flush()
  w.destroy()
}

test('lazy loading: open loads keys only, values come from IndexedDB through a bounded LRU', async () => {
  const nm = name()
  let db = new RocksDB(nm)
  await fill(db, 500)
  await db.close()

  db = new RocksDB(nm, { cacheBytes: 16 * 1024 })
  await db.ready()
  let st = db.persistenceStats
  assert.equal(st.keys, 500)
  assert.equal(st.cacheEntries, 0, 'no value loaded at open')
  assert.equal(st.pinnedBytes, 0)
  for (let i = 0; i < 500; i += 7) {
    const v = await db.get('k' + String(i).padStart(6, '0'))
    assert.equal(v.byteLength, 1024)
    assert.equal(v[0], i % 251)
  }
  st = db.persistenceStats
  assert.ok(st.cacheBytes <= 16 * 1024, 'cache stays within budget: ' + st.cacheBytes)
  assert.ok(st.cacheMisses > 0)
  // A hit after a miss.
  await db.get('k000497')
  const hits = db.persistenceStats.cacheHits
  await db.get('k000497')
  assert.equal(db.persistenceStats.cacheHits, hits + 1)

  // Iterators read the values of a run of keys in one request, not one per key.
  const reads = db.persistenceStats.reads
  const got = await all(db.iterator({ gte: 'k000100', lt: 'k000300' }))
  assert.equal(got.length, 200)
  assert.ok(got.every(([k, v], i) => k === 'k' + String(100 + i).padStart(6, '0') && v.length === 1024))
  const used = db.persistenceStats.reads - reads
  assert.ok(used <= 8, 'range reads for 200 values: ' + used)
  const rev = await all(db.iterator({ gte: 'k000100', lt: 'k000140', reverse: true }))
  assert.deepEqual(rev.map((e) => e[0]), got.slice(0, 40).map((e) => e[0]).reverse())
  await db.close()
})

test('sequential gets read ahead with range requests; writes racing the read-ahead win', async () => {
  const nm = name()
  let db = new RocksDB(nm)
  await fill(db, 300, 8)
  await db.close()
  db = new RocksDB(nm, { cacheBytes: 1024 * 1024 })
  await db.ready()
  const key = (i) => 'k' + String(i).padStart(6, '0')
  const reads = db.persistenceStats.reads
  for (let i = 0; i < 150; i++) assert.equal((await db.get(key(i)))[0], i % 251)
  const used = db.persistenceStats.reads - reads
  assert.ok(used < 20, '150 sequential gets took ' + used + ' IndexedDB reads')
  // Overwrite keys just ahead of the reader while read-aheads are in flight.
  for (let i = 150; i < 300; i++) {
    const p = db.get(key(i))
    const w = i + 3 < 300 ? db.put(key(i + 3), 'n' + (i + 3)) : null
    const v = await p
    await w
    if (i >= 153) assert.equal(s(v), 'n' + i, 'get ' + i + ' sees the acknowledged overwrite')
  }
  for (let i = 153; i < 300; i++) assert.equal(s(await db.get(key(i))), 'n' + i)
  await db.close()
})

test('read batches mix cached, dirty and missing values in one IndexedDB transaction', async () => {
  const nm = name()
  let db = new RocksDB(nm)
  await fill(db, 50, 10)
  await db.close()
  db = new RocksDB(nm, { cacheBytes: 0, autoCompact: false })
  await db.put('k000003', 'dirty')
  const reads = db.persistenceStats.reads
  const r = db.read({ autoDestroy: true })
  const ps = ['k000001', 'k000003', 'k000049', 'nope'].map((k) => r.get(k))
  r.tryFlush()
  const vals = await Promise.all(ps)
  assert.equal(vals[0].byteLength, 10)
  assert.equal(s(vals[1]), 'dirty')
  assert.equal(vals[2][0], 49)
  assert.equal(vals[3], null)
  assert.equal(db.persistenceStats.reads - reads, 1)
  await db.close()
})

test('snapshots see old values that were never in memory (put, delete, deleteRange)', async () => {
  const nm = name()
  let db = new RocksDB(nm)
  for (const k of ['a', 'b', 'c', 'd', 'e']) await db.put(k, k + '1')
  await db.close()

  db = new RocksDB(nm, { cacheBytes: 0 }) // nothing cached: every old value must be read from kv
  await db.ready()
  const snap = db.snapshot()
  const w = db.write()
  w.tryPut('a', 'a2')
  w.tryDelete('b')
  w.tryDeleteRange('c', 'e')
  w.tryPut('z', 'z2')
  await w.flush()
  await db.flush() // compacted: kv now holds the new state
  assert.equal(s(await snap.get('a')), 'a1')
  assert.equal(s(await snap.get('b')), 'b1')
  assert.equal(s(await snap.get('c')), 'c1')
  assert.equal(await snap.get('z'), null)
  assert.deepEqual(await all(snap.iterator({})), [['a', 'a1'], ['b', 'b1'], ['c', 'c1'], ['d', 'd1'], ['e', 'e1']])
  assert.deepEqual(await all(snap.iterator({ reverse: true, lt: 'e' })), [['d', 'd1'], ['c', 'c1'], ['b', 'b1'], ['a', 'a1']])
  assert.deepEqual(await all(db.iterator({})), [['a', 'a2'], ['e', 'e1'], ['z', 'z2']])
  await snap.close()
  await db.close()
})

test('an iterator over uncached values ignores writes made while it runs', async () => {
  const nm = name()
  let db = new RocksDB(nm)
  await fill(db, 100, 8)
  await db.close()
  db = new RocksDB(nm, { cacheBytes: 0, walMaxRecords: 1, compactDelay: 0 })
  const seen = []
  for await (const e of db.iterator({}, { capacity: 1 })) {
    seen.push([s(e.key), e.value[0]])
    if (seen.length === 1) {
      await db.deleteRange('k000050', 'k000060')
      await db.put('k000070', b4a.alloc(8, 200))
      await db.put('k000070x', 'new')
      await db.flush()
    }
  }
  assert.equal(seen.length, 100)
  assert.equal(seen[55][0], 'k000055')
  assert.equal(seen[70][1], 70)
  const live = await all(db.iterator({}))
  assert.equal(live.length, 91)
  await db.close()
})

test('randomized: snapshots and iterators match a reference model (tiny cache, eager compaction)', async () => {
  const nm = name()
  const db = new RocksDB(nm, { cacheBytes: 600, walMaxRecords: 2, compactDelay: 0 })
  const model = new Map()
  const keys = Array.from({ length: 40 }, (_, i) => 'r' + String(i).padStart(2, '0'))
  let seed = 7
  const rnd = (m) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % m
  }
  const sorted = (m) => [...m].sort((x, y) => (x[0] < y[0] ? -1 : 1))
  const snaps = []
  for (let round = 0; round < 60; round++) {
    // A few concurrent batches per round: they apply in flush order.
    const flushes = []
    for (let b = 0; b < 1 + rnd(3); b++) {
      const w = db.write({ autoDestroy: true })
      for (let o = 0; o < 1 + rnd(5); o++) {
        const r = rnd(10)
        const k = keys[rnd(keys.length)]
        if (r < 6) {
          const v = 'v' + round + '-' + b + '-' + o + '-' + 'x'.repeat(rnd(300))
          w.tryPut(k, v)
          model.set(k, v)
        } else if (r < 9) {
          w.tryDelete(k)
          model.delete(k)
        } else {
          const e = keys[Math.min(keys.length - 1, keys.indexOf(k) + rnd(6))]
          w.tryDeleteRange(k, e)
          for (const mk of [...model.keys()]) if (mk >= k && mk < e) model.delete(mk)
        }
      }
      flushes.push(w.flush())
    }
    await Promise.all(flushes)
    if (rnd(4) === 0) snaps.push({ db: db.snapshot(), model: new Map(model) })
    if (rnd(5) === 0 && snaps.length > 3) await snaps.shift().db.close()
    for (const sn of snaps) {
      const k = keys[rnd(keys.length)]
      assert.equal(s(await sn.db.get(k)), sn.model.has(k) ? sn.model.get(k) : null, 'snapshot get ' + k + ' round ' + round)
    }
    if (round % 10 === 9) {
      for (const sn of snaps) assert.deepEqual(await all(sn.db.iterator({})), sorted(sn.model), 'snapshot iterator round ' + round)
      assert.deepEqual(await all(db.iterator({})), sorted(model))
    }
  }
  for (const sn of snaps) await sn.db.close()
  await db.close()
  const again = new RocksDB(nm, { cacheBytes: 0 })
  assert.deepEqual(await all(again.iterator({})), sorted(model))
  await again.close()
})

test('a slow read that races a write does not put a stale value in the cache', async () => {
  const nm = name()
  const slow = {
    encrypt: async (u8) => b4a.concat([b4a.from([7]), u8]),
    decrypt: async (u8) => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return u8.subarray(1)
    }
  }
  let db = new RocksDB(nm, { cipher: slow })
  await db.put('k', 'v1')
  await db.close()
  db = new RocksDB(nm, { cipher: slow, walMaxRecords: 1, compactDelay: 0 })
  await db.ready()
  const before = db.get('k') // cache miss, the value arrives after the write below
  await db.put('k', 'v2')
  await db.flush() // compacted: v2 moves to the cache
  assert.equal(s(await before), 'v1')
  assert.equal(s(await db.get('k')), 'v2')
  await db.close()
})

test('WAL: one record per group commit, compaction moves them into kv, reopen replays the rest', async () => {
  const nm = name()
  let db = new RocksDB(nm, { autoCompact: false })
  await db.ready()
  const flushes = []
  for (let i = 0; i < 20; i++) flushes.push(db.put('w' + String(i).padStart(2, '0'), 'v' + i))
  await Promise.all(flushes)
  let st = db.persistenceStats
  assert.ok(st.walRecords < 20, 'group commit: ' + st.walRecords + ' records for 20 batches')
  assert.equal(st.walPending, st.walRecords)
  assert.equal((await rawWAL(nm)).length, st.walRecords)
  assert.equal((await rawKV(nm)).length, 0, 'nothing in kv before compaction')

  await db.put('w00', 'again')
  await db.flush()
  st = db.persistenceStats
  assert.equal(st.walPending, 0)
  assert.equal(st.pinnedBytes, 0, 'compacted values are no longer pinned')
  assert.equal((await rawWAL(nm)).length, 0)
  assert.equal((await rawKV(nm)).length, 20)

  await db.delete('w01')
  await db.deleteRange('w10', 'w15')
  await db.put('w99', 'last')
  kill(db) // not compacted, not closed
  assert.ok((await rawWAL(nm)).length >= 1)

  db = new RocksDB(nm, { autoCompact: false })
  await db.ready()
  assert.equal(db.persistenceStats.replayed, 3)
  const got = await all(db.iterator({}))
  assert.equal(got.length, 20 - 1 - 5 + 1)
  assert.deepEqual(got[0], ['w00', 'again'])
  assert.deepEqual(got[got.length - 1], ['w99', 'last'])
  await db.close() // close compacts
  assert.equal((await rawWAL(nm)).length, 0)
})

test('migration: a v1 database (kv store only) opens, keeps its data and upgrades to v2', async () => {
  const nm = name()
  await new Promise((resolve, reject) => {
    const req = indexedDB.open(nm, 1)
    req.onupgradeneeded = () => {
      const kv = req.result.createObjectStore('kv')
      kv.put(b4a.from('one'), 'default/' + b4a.toString(b4a.from('a'), 'hex'))
      kv.put(b4a.from('two'), 'corestore/' + b4a.toString(b4a.from('b'), 'hex'))
    }
    req.onsuccess = () => {
      req.result.close()
      resolve()
    }
    req.onerror = () => reject(req.error)
  })
  const db = new RocksDB(nm)
  assert.equal(s(await db.get('a')), 'one')
  const cf = db.columnFamily('corestore')
  assert.equal(s(await cf.get('b')), 'two')
  await cf.put('c', 'three')
  await cf.close()
  await db.close()
  const version = await new Promise((resolve) => {
    const req = indexedDB.open(nm)
    req.onsuccess = () => {
      const v = req.result.version
      const stores = [...req.result.objectStoreNames]
      req.result.close()
      resolve([v, stores])
    }
  })
  assert.deepEqual(version, [2, ['kv', 'meta', 'wal']])
})

test('quota: a failed WAL commit rejects the batch with QUOTA_EXCEEDED, reports it, and makes the db read-only', async () => {
  const nm = name()
  const errors = []
  let db = new RocksDB(nm, { onerror: (err) => errors.push(err) })
  await db.put('ok', '1')
  const restore = inject({ store: 'wal', mode: 'quota' })
  const w = db.write()
  w.tryPut('lost-a', 'x')
  w.tryPut('lost-b', 'y')
  const p = w.put('lost-c', 'z')
  await assert.rejects(w.flush(), (err) => err.code === 'QUOTA_EXCEEDED')
  await assert.rejects(p, (err) => err.code === 'QUOTA_EXCEEDED')
  restore()
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'QUOTA_EXCEEDED')
  assert.equal(db.storageError, errors[0])
  assert.equal(db.persistenceStats.error, 'QUOTA_EXCEEDED')
  // Memory == disk: the failed batch is not visible, earlier ones are, reads still work.
  assert.equal(await db.get('lost-a'), null)
  assert.equal(s(await db.get('ok')), '1')
  // Read-only until reopened, even once space is back.
  await assert.rejects(db.put('later', '1'), (err) => err.code === 'QUOTA_EXCEEDED' && /read-only/.test(err.message))
  await assert.rejects(db.flush(), /read-only/)
  assert.equal(errors.length, 1, 'reported once')
  await db.close()

  db = new RocksDB(nm)
  assert.equal(s(await db.get('ok')), '1')
  assert.equal(await db.get('lost-b'), null)
  await db.put('later', '1')
  assert.equal(s(await db.get('later')), '1')
  await db.close()
})

test('IDB_ERROR: an aborted commit transaction rejects with IDB_ERROR', async () => {
  const nm = name()
  const db = new RocksDB(nm)
  await db.put('a', '1')
  const restore = inject({ store: 'wal', mode: 'abort' })
  await assert.rejects(db.put('b', '2'), (err) => err.code === 'IDB_ERROR')
  restore()
  assert.equal(db.storageError.code, 'IDB_ERROR')
  await db.close()
})

test('a failed compaction keeps everything in the WAL (nothing lost)', async () => {
  const nm = name()
  const errors = []
  let db = new RocksDB(nm, { autoCompact: false, onerror: (e) => errors.push(e) })
  for (let i = 0; i < 10; i++) await db.put('c' + i, 'v' + i)
  const restore = inject({ store: 'kv', mode: 'quota', at: 4 })
  await assert.rejects(db.flush(), (err) => err.code === 'QUOTA_EXCEEDED')
  restore()
  assert.equal(errors.length, 1)
  assert.equal(s(await db.get('c9')), 'v9')
  kill(db)
  assert.equal((await rawKV(nm)).length, 0, 'compaction rolled back')
  db = new RocksDB(nm)
  assert.equal((await all(db.iterator({}))).length, 10)
  await db.close()
  assert.equal((await rawKV(nm)).length, 10)
})

test('cipher: values and WAL records are sealed at rest, keys stay ordered, wrong key fails clearly', async () => {
  const nm = name()
  const { cipher, key } = await randomCipher()
  let db = new RocksDB(nm, { cipher, autoCompact: false })
  const secret = 'TOP-SECRET-VALUE'
  for (const k of ['b', 'a', 'c']) await db.put(k, secret + k)
  const wal = await rawWAL(nm)
  assert.ok(wal.length > 0)
  for (const [, v] of wal) assert.ok(!b4a.toString(b4a.from(v)).includes(secret), 'WAL record is sealed')
  await db.flush()
  const kv = await rawKV(nm)
  assert.deepEqual(kv.map(([k]) => k), ['default/61', 'default/62', 'default/63'])
  for (const [, v] of kv) assert.ok(!b4a.toString(b4a.from(v)).includes(secret), 'value is sealed')
  await db.close()

  db = new RocksDB(nm, { cipher: RocksDB.aesGcmCipher(key), cacheBytes: 0 })
  assert.deepEqual(await all(db.iterator({})), [['a', secret + 'a'], ['b', secret + 'b'], ['c', secret + 'c']])
  assert.equal(s(await db.get('b')), secret + 'b')
  await db.close()

  const wrong = await randomCipher()
  await assert.rejects(new RocksDB(nm, { cipher: wrong.cipher }).ready(), (err) => err.code === 'DECRYPT_FAILED')
  await assert.rejects(new RocksDB(nm).ready(), (err) => err.code === 'CIPHER_MISMATCH')

  const plain = name()
  const p = new RocksDB(plain)
  await p.put('x', 'y')
  await p.close()
  await assert.rejects(new RocksDB(plain, { cipher }).ready(), (err) => err.code === 'CIPHER_MISMATCH')
})

test('cipher: a tampered value fails the read with DECRYPT_FAILED, not garbage', async () => {
  const nm = name()
  const { cipher } = await randomCipher()
  let db = new RocksDB(nm, { cipher })
  await db.put('a', 'value')
  await db.close()
  await new Promise((resolve, reject) => {
    const req = indexedDB.open(nm)
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', 'readwrite')
      const store = tx.objectStore('kv')
      const g = store.get('default/61')
      g.onsuccess = () => {
        const v = new Uint8Array(g.result)
        v[v.length - 1] ^= 1
        store.put(v, 'default/61')
      }
      tx.oncomplete = () => {
        req.result.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
  })
  db = new RocksDB(nm, { cipher })
  await assert.rejects(db.get('a'), (err) => err.code === 'DECRYPT_FAILED')
  await db.close()
})

test('aesGcmCipher round-trips and prefixes a fresh 12-byte IV', async () => {
  const { cipher } = await randomCipher()
  const m = b4a.from('hello')
  const a = await cipher.encrypt(m)
  const b = await cipher.encrypt(m)
  assert.equal(a.byteLength, 12 + 5 + 16)
  assert.ok(!b4a.equals(a.subarray(0, 12), b.subarray(0, 12)))
  assert.equal(b4a.toString(await cipher.decrypt(a)), 'hello')
  await assert.rejects(cipher.decrypt(a.subarray(0, 20)), (err) => err.code === 'DECRYPT_FAILED')
})

test('single-writer lock: a second instance on the same name gets LOCKED until the first closes', async () => {
  const nm = name()
  const locks = fakeLocks()
  const a = new RocksDB(nm, { locks })
  await a.ready()
  assert.deepEqual(locks.held(), ['rocksdb-idb:' + nm])
  const b = new RocksDB(nm, { locks })
  await assert.rejects(b.ready(), (err) => err.code === 'LOCKED')
  const c = new RocksDB(nm, { locks, lock: false })
  await c.ready() // opting out
  await c.close()
  await a.close()
  assert.deepEqual(locks.held(), [])
  const d = new RocksDB(nm, { locks })
  await d.put('k', 'v')
  await d.close()
})

test('storageEstimate / requestPersist use navigator.storage when present', async () => {
  assert.equal(await RocksDB.storageEstimate({ navigator: undefined }), null)
  assert.equal(await RocksDB.requestPersist({ navigator: {} }), false)
  let asked = 0
  const navigator = {
    storage: {
      estimate: async () => ({ usage: 100, quota: 1000 }),
      persisted: async () => false,
      persist: async () => ++asked > 0
    }
  }
  assert.deepEqual(await RocksDB.storageEstimate({ navigator }), { usage: 100, quota: 1000, available: 900 })
  assert.equal(await RocksDB.requestPersist({ navigator }), true)
  assert.equal(asked, 1)
})
