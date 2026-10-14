// Preload (`node -r`): makes `require('rocksdb-native')` load rocksdb-idb, over fake-indexeddb
// (ROCKSDB_IDB_MEMORY=1: memory only). Used to run hypercore-storage's own test suite and the
// Corestore/Autobase checks against the adapter in Node.
const Module = require('module')
const path = require('path')
const here = path.dirname(require.resolve('./register.cjs'))

const adapter = path.join(here, '..', 'index.js')
// SODIUM_SHIM=1: the browser's sodium (sodium-javascript + spike/shims/sodium.js) in Node too.
const sodiumShim = process.env.SODIUM_SHIM === '1' ? path.join(here, '..', 'spike', 'shims', 'sodium.js') : null
const resolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'rocksdb-native') return adapter
  if (sodiumShim && request === 'sodium-native') return sodiumShim
  return resolve.call(this, request, parent, ...rest)
}

if (process.env.ROCKSDB_IDB_MEMORY === '1') {
  globalThis.indexedDB = undefined
} else {
  require('fake-indexeddb/auto')
}
