// AES-GCM value cipher for rocksdb-idb's `cipher` option (WebCrypto; Node's globalThis.crypto too).
// Sealed format: [12-byte random IV][ciphertext + 16-byte tag]. A wrong key or tampered data fails
// the tag check and throws an error with code 'DECRYPT_FAILED'.
//
//   const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
//   new RocksDB(name, { cipher: aesGcmCipher(key) })
//
// Random 96-bit IVs: keep well under 2^32 encryptions per key (rotate the key by re-creating the db).

const { RocksDBIDBError } = require('./errors')

const IV = 12
const TAG = 16

function aesGcmCipher(key, { crypto = globalThis.crypto } = {}) {
  if (!crypto || !crypto.subtle) throw new Error('WebCrypto is not available')
  const subtle = crypto.subtle
  return {
    async encrypt(data) {
      const iv = crypto.getRandomValues(new Uint8Array(IV))
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, data))
      const out = new Uint8Array(IV + ct.byteLength)
      out.set(iv, 0)
      out.set(ct, IV)
      return out
    },
    async decrypt(data) {
      if (data.byteLength < IV + TAG) throw new RocksDBIDBError('Ciphertext too short', 'DECRYPT_FAILED')
      try {
        return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, IV) }, key, data.subarray(IV)))
      } catch (err) {
        throw new RocksDBIDBError('AES-GCM decryption failed (wrong key or corrupted data)', 'DECRYPT_FAILED', err)
      }
    }
  }
}

module.exports = { aesGcmCipher }
