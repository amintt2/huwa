// navigator.storage helpers (StorageManager), safe where it is missing (old browsers, Node).

function manager(navigator) {
  return navigator && navigator.storage ? navigator.storage : null
}

/** { usage, quota, available } in bytes, or null when the browser cannot tell. */
async function storageEstimate({ navigator = globalThis.navigator } = {}) {
  const m = manager(navigator)
  if (!m || typeof m.estimate !== 'function') return null
  const { usage = 0, quota = 0 } = await m.estimate()
  return { usage, quota, available: Math.max(0, quota - usage) }
}

/** Asks for persistent storage (no eviction under pressure); resolves true when granted. */
async function requestPersist({ navigator = globalThis.navigator } = {}) {
  const m = manager(navigator)
  if (!m || typeof m.persist !== 'function') return false
  if (typeof m.persisted === 'function' && (await m.persisted())) return true
  return !!(await m.persist())
}

module.exports = { storageEstimate, requestPersist }
