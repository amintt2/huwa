// rocksdb-idb with default options taken from the environment, for running suites that construct
// `new RocksDB(path)` themselves (hypercore-storage's) in other configurations:
//   ROCKSDB_IDB_OPTS='{"cacheBytes":4096,"walMaxRecords":2}'   extra constructor options (JSON)
//   ROCKSDB_IDB_CIPHER=1                                         AES-GCM cipher (one key per process)
const RocksDB = require('../index.js')

const extra = JSON.parse(process.env.ROCKSDB_IDB_OPTS || '{}')
if (process.env.ROCKSDB_IDB_CIPHER === '1') {
  const key = globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  let inner = null
  const cipher = async () => inner || (inner = RocksDB.aesGcmCipher(await key))
  extra.cipher = {
    encrypt: async (u8) => (await cipher()).encrypt(u8),
    decrypt: async (u8) => (await cipher()).decrypt(u8)
  }
}

class EnvRocksDB extends RocksDB {
  constructor(path, opts = {}) {
    super(path, opts.state ? opts : { ...extra, ...opts })
  }
}

Object.assign(EnvRocksDB, RocksDB)
module.exports = EnvRocksDB
