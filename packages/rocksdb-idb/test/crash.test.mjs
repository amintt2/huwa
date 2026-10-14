// Crash consistency (fake-indexeddb): every acknowledged batch survives, no batch is partially
// visible, WAL replay is idempotent, Corestore / Hypercore reopen intact after a crash.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import b4a from 'b4a'
import { kill, inject, rawWAL, all } from './helpers.mjs'

const require = createRequire(import.meta.url)
require('./register.cjs') // fake-indexeddb + rocksdb-native -> rocksdb-idb for hypercore-storage
const RocksDB = require('../index.js')

let n = 0
const name = () => 'crash-' + process.pid + '-' + n++
const sorted = (m) => [...m].sort((x, y) => (x[0] < y[0] ? -1 : 1))

// Batch i: four keys of its own, an overwrite of a shared key, and every third batch removes the
// keys of batch i - 2 with a range delete.
function batchOps(i) {
  const ops = []
  for (let j = 0; j < 4; j++) ops.push(['put', 'b' + String(i).padStart(2, '0') + '-' + j, 'v' + i])
  if (i % 4 === 3) ops.push(['put', 'counter', 'c' + i])
  if (i % 3 === 2) ops.push(['range', 'b' + String(i - 2).padStart(2, '0') + '-', 'b' + String(i - 2).padStart(2, '0') + '.'])
  if (i % 5 === 4) ops.push(['del', 'b' + String(i - 1).padStart(2, '0') + '-0'])
  return ops
}

function model(count) {
  const m = new Map()
  for (let i = 0; i < count; i++) {
    for (const [type, a, b] of batchOps(i)) {
      if (type === 'put') m.set(a, b)
      else if (type === 'del') m.delete(a)
      else for (const k of [...m.keys()]) if (k >= a && k < b) m.delete(k)
    }
  }
  return sorted(m)
}

function writeBatch(db, i) {
  const w = db.write({ autoDestroy: true })
  for (const [type, a, b] of batchOps(i)) {
    if (type === 'put') w.tryPut(a, b)
    else if (type === 'del') w.tryDelete(a)
    else w.tryDeleteRange(a, b)
  }
  return w.flush()
}

const BATCHES = 14

test('fault sweep: a failure at every IndexedDB write, then a crash, loses no acknowledged batch and splits none', async () => {
  let points = 0
  for (const mode of ['quota', 'abort']) {
    for (let at = 1; ; at++) {
      const nm = name()
      let hit = false
      const db = new RocksDB(nm, { walMaxRecords: 3, compactDelay: false })
      await db.ready()
      const restore = inject({ store: '*', mode, at, onHit: () => (hit = true) })
      let acked = 0
      try {
        for (let i = 0; i < BATCHES; i++) {
          await writeBatch(db, i)
          acked++
        }
        await db.flush()
      } catch {}
      restore()
      kill(db)
      const again = new RocksDB(nm)
      const got = await all(again.iterator({}))
      const ok = JSON.stringify(got) === JSON.stringify(model(acked)) || JSON.stringify(got) === JSON.stringify(model(acked + 1))
      assert.ok(ok, mode + ' at write #' + at + ': ' + acked + ' acked, state does not match')
      await again.close()
      points++
      if (!hit) break // the workload finished before the injection point: every point covered
    }
  }
  assert.ok(points > 40, 'covered ' + points + ' crash points')
})

test('crash with batches in flight: acknowledged ones survive, each batch is all-or-nothing', async () => {
  const nm = name()
  const db = new RocksDB(nm, { walMaxRecords: 4, compactDelay: 0 })
  await db.ready()
  const acked = new Set()
  const flushes = []
  for (let i = 0; i < 40; i++) {
    flushes.push(writeBatch(db, i).then(() => acked.add(i), () => {}))
    if (i % 7 === 6) await new Promise((resolve) => setImmediate(resolve))
  }
  await new Promise((resolve) => setImmediate(resolve))
  kill(db)
  await Promise.allSettled(flushes)
  const again = new RocksDB(nm)
  const got = await all(again.iterator({}))
  // Batches apply in order: the state is model(k) for some k covering every acknowledged batch.
  const max = acked.size ? Math.max(...acked) + 1 : 0
  let match = -1
  for (let k = max; k <= 40; k++) if (JSON.stringify(got) === JSON.stringify(model(k))) match = k
  assert.ok(match >= max, 'state is a prefix of the batches containing all ' + acked.size + ' acked ones')
  await again.close()
})

test('WAL replay is idempotent (replayed twice, and over a kv that already has the records)', async () => {
  const nm = name()
  let db = new RocksDB(nm, { autoCompact: false })
  for (let i = 0; i < BATCHES; i++) await writeBatch(db, i)
  const expected = model(BATCHES)
  kill(db)
  const wal = await rawWAL(nm)
  assert.ok(wal.length >= BATCHES - 1)

  for (let round = 0; round < 2; round++) {
    db = new RocksDB(nm, { autoCompact: false })
    assert.deepEqual(await all(db.iterator({})), expected, 'replay round ' + round)
    kill(db)
  }

  // Compact, then put the old WAL records back: replaying them over kv changes nothing.
  db = new RocksDB(nm)
  await db.flush()
  await db.close()
  assert.equal((await rawWAL(nm)).length, 0)
  await new Promise((resolve, reject) => {
    const req = indexedDB.open(nm)
    req.onsuccess = () => {
      const tx = req.result.transaction('wal', 'readwrite')
      for (const [k, v] of wal) tx.objectStore('wal').put(v, k)
      tx.oncomplete = () => {
        req.result.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
  })
  db = new RocksDB(nm)
  assert.deepEqual(await all(db.iterator({})), expected)
  await db.flush()
  assert.deepEqual(await all(db.iterator({})), expected)
  await db.close()
})

test('crash during compaction: the WAL is replayed and nothing is lost', async () => {
  const nm = name()
  const db = new RocksDB(nm, { autoCompact: false })
  for (let i = 0; i < BATCHES; i++) await writeBatch(db, i)
  const restore = inject({ store: 'kv', mode: 'abort', at: 10 })
  await assert.rejects(db.flush())
  restore()
  kill(db)
  const again = new RocksDB(nm, { cacheBytes: 0 })
  assert.deepEqual(await all(again.iterator({})), model(BATCHES))
  await again.close()
})

test('Corestore / Hypercore reopen intact after a crash (no close)', async () => {
  const CorestoreStorage = require('hypercore-storage')
  const Corestore = require('corestore')
  const nm = name()
  let rocks = new RocksDB(nm, { walMaxRecords: 8 })
  let store = new Corestore(new CorestoreStorage(rocks))
  let core = store.get({ name: 'log' })
  await core.ready()
  const key = core.key
  for (let i = 0; i < 150; i++) await core.append(b4a.from('block ' + i))
  await core.truncate(120)
  for (let i = 120; i < 130; i++) await core.append(b4a.from('again ' + i))
  const hash = await core.treeHash()
  kill(rocks)

  rocks = new RocksDB(nm, { cacheBytes: 4096 })
  store = new Corestore(new CorestoreStorage(rocks))
  core = store.get({ name: 'log' })
  await core.ready()
  assert.ok(b4a.equals(core.key, key))
  assert.equal(core.length, 130)
  assert.ok(b4a.equals(await core.treeHash(), hash), 'same Merkle tree')
  assert.equal(b4a.toString(await core.get(42)), 'block 42')
  assert.equal(b4a.toString(await core.get(125)), 'again 125')
  const blocks = []
  for await (const b of core.createReadStream()) blocks.push(b4a.toString(b))
  assert.equal(blocks.length, 130)
  assert.equal(blocks[119], 'block 119')
  await store.close()
})
