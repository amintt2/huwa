// Errors with a stable `code`, so a worker can forward them to the UI:
//   QUOTA_EXCEEDED   the browser refused to store more data
//   IDB_ERROR        any other IndexedDB failure (aborted transaction, connection lost, ...)
//   DECRYPT_FAILED   a value / WAL record / cipher check did not decrypt (wrong key or corruption)
//   CIPHER_MISMATCH  encrypted database opened without a cipher, or the reverse
//   LOCKED           another context holds the single-writer lock
//   READ_ONLY        a write after a storage error (the database is read-only until reopened)

class RocksDBIDBError extends Error {
  constructor(message, code, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'RocksDBIDBError'
    this.code = code
  }
}

function isQuota(err) {
  if (!err) return false
  const n = err.name
  return n === 'QuotaExceededError' || n === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22 || (err.inner ? isQuota(err.inner) : false)
}

/** Wraps an IndexedDB failure (DOMException, Error, null) into a coded error. */
function storageError(err, what) {
  if (err && typeof err.code === 'string') return err
  if (isQuota(err)) return new RocksDBIDBError('IndexedDB quota exceeded during ' + what, 'QUOTA_EXCEEDED', err)
  const detail = err ? ': ' + (err.message || err.name || String(err)) : ''
  return new RocksDBIDBError('IndexedDB ' + what + ' failed' + detail, 'IDB_ERROR', err || undefined)
}

module.exports = { RocksDBIDBError, storageError, isQuota }
