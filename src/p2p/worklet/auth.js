// Binds an Autobase writer core to an identity (keet-identity-key proof chain).
// The device key attests `writerKey || homeKey`; the chain links the device to the root identity.
const b4a = require('b4a')
const IdentityKey = require('keet-identity-key')
const { toHex, fromHex, isKey } = require('./util')

const MAX_PROOF_HEX = 2048

function makeAuth({ device, proof, writerKey, homeKey }) {
  const data = b4a.concat([writerKey, homeKey])
  const p = IdentityKey.attestData(data, device, proof)
  return { p: toHex(p), h: toHex(homeKey) }
}

/** Returns `{ identity, device, home }` (hex) or null. Pure: no clock, no I/O. */
function verifyAuth(auth, writerKey) {
  if (!auth || typeof auth !== 'object') return null
  if (typeof auth.p !== 'string' || auth.p.length > MAX_PROOF_HEX || !/^[0-9a-f]+$/.test(auth.p)) return null
  if (!isKey(auth.h)) return null
  try {
    const info = IdentityKey.verify(fromHex(auth.p), b4a.concat([writerKey, fromHex(auth.h)]))
    if (!info) return null
    return { identity: toHex(info.identityPublicKey), device: toHex(info.devicePublicKey), home: auth.h }
  } catch {
    return null
  }
}

/** Verify a device proof (no attested data), optionally for an expected device. */
function verifyDeviceProof(proof, expectedDevice) {
  try {
    const info = IdentityKey.verify(proof, null, expectedDevice ? { expectedDevice } : {})
    if (!info) return null
    return { identity: toHex(info.identityPublicKey), device: toHex(info.devicePublicKey) }
  } catch {
    return null
  }
}

module.exports = { makeAuth, verifyAuth, verifyDeviceProof, MAX_PROOF_HEX }
