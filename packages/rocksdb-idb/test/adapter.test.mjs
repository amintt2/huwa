// rocksdb-idb semantics, over fake-indexeddb (run with `npm test` in packages/rocksdb-idb).
import test from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import b4a from 'b4a'
import RocksDB from '../index.js'

let n = 0
const name = () => 'adapter-' + process.pid + '-' + n++
const s = (b) => (b ? b4a.toString(b) : b)
const all = async (it) => {
  const out = []
  for await (const e of it) out.push([s(e.key), s(e.value)])
  return out
}

test('put / get / delete, missing keys are null, values are copies', async () => {
  const db = new RocksDB(name())
  await db.ready()
  const v = b4a.from('hello')
  await db.put('a', v)
  v[0] = 0 // the caller mutating its buffer must not change the stored value
  const got = await db.get('a')
  assert.equal(s(got), 'hello')
  got[0] = 0 // nor the reader mutating what it got
  assert.equal(s(await db.get('a')), 'hello')
  assert.equal(await db.get('nope'), null)
  await db.delete('a')
  assert.equal(await db.get('a'), null)
  await db.close()
})

test('read batch resolves every get on tryFlush; write batch is atomic', async () => {
  const db = new RocksDB(name())
  const w = db.write()
  w.tryPut('k1', 'v1')
  w.tryPut('k2', 'v2')
  const p = w.put('k3', 'v3')
  await w.flush()
  await p
  w.destroy()
  const r = db.read({ autoDestroy: true })
  const ps = ['k1', 'k2', 'k3', 'k4'].map((k) => r.get(k))
  r.tryFlush()
  assert.deepEqual((await Promise.all(ps)).map(s), ['v1', 'v2', 'v3', null])
  await db.close()
})

test('ordered and reverse iterators with ranges and limits', async () => {
  const db = new RocksDB(name())
  const w = db.write()
  for (const k of ['a', 'b', 'ba', 'bb', 'c', 'd']) w.tryPut(k, k.toUpperCase())
  await w.flush()
  assert.deepEqual((await all(db.iterator({ gte: 'b', lt: 'c' }))).map((e) => e[0]), ['b', 'ba', 'bb'])
  assert.deepEqual((await all(db.iterator({ gt: 'b', lte: 'c' }))).map((e) => e[0]), ['ba', 'bb', 'c'])
  assert.deepEqual((await all(db.iterator({ gte: 'b', lt: 'd', reverse: true }))).map((e) => e[0]), ['c', 'bb', 'ba', 'b'])
  assert.deepEqual((await all(db.iterator({}, { limit: 2 }))).map((e) => e[0]), ['a', 'b'])
  assert.deepEqual((await all(db.iterator({ reverse: true, limit: 1 }))).map((e) => e[0]), ['d'])
  assert.deepEqual(await db.peek({ gte: 'bb' }).then((e) => s(e.value)), 'BB')
  await db.close()
})

test('binary keys keep bytewise order (prefixes, 0x00 and 0xff)', async () => {
  const db = new RocksDB(name())
  const keys = [[0x01], [0x01, 0x00], [0x01, 0xff], [0x02], [0xff], [0xff, 0x00]].map((k) => b4a.from(k))
  const w = db.write()
  for (const k of [...keys].reverse()) w.tryPut(k, k)
  await w.flush()
  const got = []
  for await (const e of db.iterator({})) got.push(b4a.toString(e.key, 'hex'))
  assert.deepEqual(got, keys.map((k) => b4a.toString(k, 'hex')))
  await db.close()
})

test('deleteRange removes [start, end)', async () => {
  const db = new RocksDB(name())
  const w = db.write()
  for (const k of ['a', 'b', 'c', 'd']) w.tryPut(k, k)
  w.tryDeleteRange('b', 'd')
  await w.flush()
  assert.deepEqual((await all(db.iterator({}))).map((e) => e[0]), ['a', 'd'])
  await db.close()
})

test('snapshots are immutable (put, delete, deleteRange) and sessions share them', async () => {
  const db = new RocksDB(name())
  await db.put('a', '1')
  await db.put('b', '1')
  await db.put('c', '1')
  const snap = db.snapshot()
  assert.ok(snap.snapshotted)
  const w = db.write()
  w.tryPut('a', '2')
  w.tryPut('z', 'new')
  w.tryDelete('b')
  w.tryDeleteRange('c', 'd')
  await w.flush()
  assert.equal(s(await snap.get('a')), '1')
  assert.equal(s(await snap.get('b')), '1')
  assert.equal(await snap.get('z'), null)
  assert.deepEqual(await all(snap.iterator({})), [['a', '1'], ['b', '1'], ['c', '1']])
  assert.deepEqual(await all(snap.iterator({ reverse: true })), [['c', '1'], ['b', '1'], ['a', '1']])
  const sub = snap.session()
  assert.ok(sub.snapshotted)
  assert.equal(s(await sub.get('a')), '1')
  assert.deepEqual(await all(db.iterator({})), [['a', '2'], ['z', 'new']])
  await sub.close()
  await snap.close()
  assert.equal(db._state.snapshots.size, 0, 'released snapshots stop recording')
  await db.close()
})

test('an iterator does not see writes made while it is open (implicit snapshot)', async () => {
  const db = new RocksDB(name())
  for (const k of ['a', 'b', 'c']) await db.put(k, k)
  const it = db.iterator({}, { capacity: 1 })
  const seen = []
  for await (const e of it) {
    seen.push(s(e.key))
    if (seen.length === 1) {
      await db.delete('c')
      await db.put('bb', 'x')
    }
  }
  assert.deepEqual(seen, ['a', 'b', 'c'])
  await db.close()
})

test('column families are separate key spaces', async () => {
  const db = new RocksDB(name())
  const cf = db.columnFamily(new RocksDB.ColumnFamily('corestore'))
  await cf.put('k', 'cf')
  await db.put('k', 'default')
  assert.equal(s(await cf.get('k')), 'cf')
  assert.equal(s(await db.get('k')), 'default')
  await cf.close()
  await db.close()
})

test('persists to IndexedDB and reloads (group commit)', async () => {
  const nm = name()
  let db = new RocksDB(nm)
  const cf = db.columnFamily('corestore')
  const batches = []
  for (let i = 0; i < 50; i++) {
    const w = cf.write({ autoDestroy: true })
    w.tryPut('k' + String(i).padStart(3, '0'), 'v' + i)
    batches.push(w.flush())
  }
  await Promise.all(batches)
  await cf.deleteRange('k010', 'k020')
  await cf.delete('k000')
  const stats = { ...db.persistenceStats }
  assert.ok(stats.transactions < 50, 'batches of the same tick share a transaction: ' + stats.transactions)
  await cf.close()
  await db.close()

  db = new RocksDB(nm)
  const cf2 = db.columnFamily('corestore')
  const keys = (await all(cf2.iterator({}))).map((e) => e[0])
  assert.equal(keys.length, 39)
  assert.equal(keys[0], 'k001')
  assert.ok(!keys.includes('k015'))
  assert.equal(s(await cf2.get('k049')), 'v49')
  await cf2.close()
  await db.close()
  await RocksDB.destroy(nm)
})

test('closed sessions throw like rocksdb-native', async () => {
  const db = new RocksDB(name())
  const sess = db.session()
  await sess.close()
  assert.throws(() => sess.read(), /closed/)
  assert.equal(sess._index, -1)
  await db.close()
  assert.ok(db.closed)
})
