// Web secret store (D6). The browser node's whole IndexedDB storage (rocksdb-idb: identity secrets,
// device key, box seed, Corestore primary key, writer keys) is encrypted at rest with a data key
// (DEK, AES-256-GCM). The DEK is never stored in clear: it is wrapped by a key-encryption key (KEK):
//   mode 'device'   KEK = random AES-GCM CryptoKey created NON-EXTRACTABLE by this browser and
//                   kept in IndexedDB (database `huwa-keys`): page scripts can use it but not read
//                   it, and a copy of the profile's files without the browser's key store is useless.
//   mode 'passkey'  KEK = HKDF(WebAuthn PRF output) derived in the page ("Lock with a passkey"):
//                   no KEK is stored; the session starts locked and the passkey unlocks it.
// The unwrapped DEK is itself a non-extractable CryptoKey. Only a mode switch (device <-> passkey)
// sees the raw DEK, transiently, to re-wrap it.
// "Public computer" mode stores nothing here: the node runs on memory-only storage.

const DB = 'huwa-keys'
const STORE = 'keys'
const META = 'meta'
const KEK = 'kek'
const AES = { name: 'AES-GCM', length: 256 }
const KEK_USAGES = ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
const DEK_USAGES = ['encrypt', 'decrypt']

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function codedError(message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

class KeyStore {
  constructor({ indexedDB = globalThis.indexedDB, crypto = globalThis.crypto, name = DB } = {}) {
    this.idb = indexedDB
    this.crypto = crypto
    this.subtle = crypto.subtle
    this.name = name
    this.db = null
  }

  async _open() {
    if (this.db) return this.db
    const req = this.idb.open(this.name, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    this.db = await reqP(req)
    this.db.onversionchange = () => {
      this.db.close()
      this.db = null
    }
    return this.db
  }

  async _get(key) {
    const db = await this._open()
    return reqP(db.transaction(STORE, 'readonly').objectStore(STORE).get(key))
  }

  async _put(entries, deletes = []) {
    const db = await this._open()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      for (const [k, v] of entries) store.put(v, k)
      for (const k of deletes) store.delete(k)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error('key store transaction aborted'))
    })
  }

  /** null when this browser holds no account, else { v, mode, credentialId?, createdAt, ... }. */
  async load() {
    const meta = await this._get(META)
    if (!meta) return null
    const { wrapped, iv, ...info } = meta
    return info
  }

  async _wrap(rawOrKey, kek) {
    const iv = this.crypto.getRandomValues(new Uint8Array(12))
    const wrapped = rawOrKey instanceof Uint8Array
      ? new Uint8Array(await this.subtle.encrypt({ name: 'AES-GCM', iv }, kek, rawOrKey))
      : new Uint8Array(await this.subtle.wrapKey('raw', rawOrKey, kek, { name: 'AES-GCM', iv }))
    return { wrapped, iv }
  }

  async _unwrap(meta, kek) {
    try {
      return await this.subtle.unwrapKey('raw', meta.wrapped, kek, { name: 'AES-GCM', iv: meta.iv }, AES, false, DEK_USAGES)
    } catch {
      throw codedError('Clé de déverrouillage incorrecte', 'BAD_KEY')
    }
  }

  /**
   * New account storage key. Returns the DEK (non-extractable).
   * @param {{ mode?: 'device' | 'passkey', kek?: CryptoKey, credentialId?: string, prfSalt?: string, extra?: object }} o
   */
  async create({ mode = 'device', kek = null, credentialId = null, prfSalt = null, extra = {} } = {}) {
    if (await this._get(META)) throw codedError('Un compte existe déjà dans ce navigateur', 'EXISTS')
    const temp = await this.subtle.generateKey(AES, true, DEK_USAGES)
    const entries = []
    if (mode === 'device') {
      kek = await this.subtle.generateKey(AES, false, KEK_USAGES)
      entries.push([KEK, kek])
    } else if (mode !== 'passkey' || !kek) throw new Error('mode de clé invalide')
    const { wrapped, iv } = await this._wrap(temp, kek)
    entries.push([META, { v: 1, mode, wrapped, iv, credentialId, prfSalt, createdAt: Date.now(), ...extra }])
    await this._put(entries)
    return this._unwrap({ wrapped, iv }, kek)
  }

  /** DEK of a 'device' account (no user action). */
  async unlockDevice() {
    const meta = await this._get(META)
    if (!meta) throw codedError('Aucun compte dans ce navigateur', 'NO_ACCOUNT')
    if (meta.mode !== 'device') throw codedError('Session verrouillée', 'LOCKED')
    const kek = await this._get(KEK)
    if (!kek) throw codedError('Clé de l’appareil introuvable', 'BAD_KEY')
    return this._unwrap(meta, kek)
  }

  /** DEK of a 'passkey' account, from the KEK the page derived from the passkey PRF. */
  async unlockWith(kek) {
    const meta = await this._get(META)
    if (!meta) throw codedError('Aucun compte dans ce navigateur', 'NO_ACCOUNT')
    return this._unwrap(meta, meta.mode === 'device' ? (await this._get(KEK)) || kek : kek)
  }

  async _raw(meta, kek) {
    try {
      return new Uint8Array(await this.subtle.decrypt({ name: 'AES-GCM', iv: meta.iv }, kek, meta.wrapped))
    } catch {
      throw codedError('Clé de déverrouillage incorrecte', 'BAD_KEY')
    }
  }

  /** device -> passkey: re-wraps the DEK under the passkey KEK and deletes the device KEK. */
  async enablePasskey(kek, { credentialId, prfSalt }) {
    const meta = await this._get(META)
    if (!meta) throw codedError('Aucun compte dans ce navigateur', 'NO_ACCOUNT')
    const current = meta.mode === 'device' ? await this._get(KEK) : kek
    const raw = await this._raw(meta, current)
    try {
      const { wrapped, iv } = await this._wrap(raw, kek)
      await this._put([[META, { ...meta, mode: 'passkey', wrapped, iv, credentialId, prfSalt }]], [KEK])
    } finally {
      raw.fill(0)
    }
  }

  /** passkey -> device (needs the passkey once more to read the DEK). */
  async disablePasskey(kek) {
    const meta = await this._get(META)
    if (!meta || meta.mode !== 'passkey') throw codedError('Aucune passkey sur cette session', 'NO_PASSKEY')
    const raw = await this._raw(meta, kek)
    try {
      const device = await this.subtle.generateKey(AES, false, KEK_USAGES)
      const { wrapped, iv } = await this._wrap(raw, device)
      await this._put([[KEK, device], [META, { ...meta, mode: 'device', wrapped, iv, credentialId: null, prfSalt: null }]])
    } finally {
      raw.fill(0)
    }
  }

  async update(patch) {
    const meta = await this._get(META)
    if (meta) await this._put([[META, { ...meta, ...patch, wrapped: meta.wrapped, iv: meta.iv, mode: meta.mode }]])
  }

  /** Forgets everything (logout). */
  async wipe() {
    if (this.db) {
      this.db.close()
      this.db = null
    }
    await reqP(this.idb.deleteDatabase(this.name)).catch(() => {})
  }

  close() {
    if (this.db) this.db.close()
    this.db = null
  }
}

/**
 * KEK from a WebAuthn PRF output (page side, also usable in the worker). Non-extractable.
 * @param {Uint8Array} prfOutput  32+ bytes
 */
async function kekFromPrf(prfOutput, { crypto = globalThis.crypto } = {}) {
  const enc = new TextEncoder()
  const base = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('huwa-web-lock-v1'), info: enc.encode('huwa/web/kek/v1') }, base, AES, false, KEK_USAGES)
}

module.exports = { KeyStore, kekFromPrf, codedError }
