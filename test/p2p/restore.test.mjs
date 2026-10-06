// Restore from the recovery phrase while the account's devices are offline must not fork the
// account (audit: a new empty personal base used to be appended to the root-owned pointer).
// Run: npm run test:p2p
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import createTestnet from 'hyperdht/testnet.js'
import worklet from '../../src/p2p/worklet/node.js'

const { HuwaNode } = worklet
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huwa-restore-'))
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('restore with every device offline fails cleanly, then succeeds on the same base', { timeout: 120000 }, async (t) => {
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap
  const nodes = new Set()
  const mk = async (name) => {
    const n = new HuwaNode({ storage: path.join(tmp, name), bootstrap, deviceName: name, restoreLookupMs: 6000 })
    await n.ready()
    nodes.add(n)
    return n
  }
  const close = async (n) => {
    nodes.delete(n)
    await n.close()
  }
  t.after(async () => {
    for (const n of nodes) await n.close().catch(() => {})
    await testnet.destroy()
  })

  const alice = await mk('alice')
  const { profile: pa, phrase } = await alice.createIdentity('Alice')
  const homeA = alice.secret.home
  await close(alice) // the only device of the account goes offline

  const alice3 = await mk('alice3')
  await assert.rejects(alice3.restoreIdentity(phrase), (err) => err.code === 'RESTORE_NOT_FOUND')
  assert.equal(alice3.secret, null, 'nothing saved on the restoring device')
  assert.equal(alice3.home, null, 'no personal base created')
  assert.equal(await alice3.local.get('secret'), null)
  assert.equal(alice3.peers.has(pa.key), false)
  // The root-owned pointer was not touched (it would otherwise point at a new, empty base).
  const { out } = await alice3._deriveRoot(phrase.join(' '))
  const ptr = alice3.store.get({ keyPair: out.pointer })
  await ptr.ready()
  assert.equal(ptr.length, 0, 'pointer not appended')
  await ptr.close()

  // The original device comes back: the same restore now joins the real base.
  const aliceBack = await mk('alice')
  assert.equal(aliceBack.secret.home, homeA)
  const restored = await alice3.restoreIdentity(phrase)
  assert.equal(restored.key, pa.key)
  assert.equal(alice3.secret.home, homeA, 'joined the original personal base')
  const deadline = Date.now() + 20000
  while (Date.now() < deadline && !(alice3.me() && alice3.me().name === 'Alice')) await new Promise((r) => setTimeout(r, 200))
  assert.equal(alice3.me() && alice3.me().name, 'Alice')
})

test('restore finds the base through a device linked by QR (no pointer on it)', { timeout: 180000 }, async (t) => {
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap
  const nodes = new Set()
  const mk = async (name) => {
    const n = new HuwaNode({ storage: path.join(tmp, 'qr-' + name), bootstrap, deviceName: name, restoreLookupMs: 15000 })
    await n.ready()
    nodes.add(n)
    return n
  }
  t.after(async () => {
    for (const n of nodes) await n.close().catch(() => {})
    await testnet.destroy()
  })

  const alice = await mk('alice')
  const { profile: pa, phrase } = await alice.createIdentity('Alice')
  const ipad = await mk('ipad')
  const invite = await alice.pairingInvite()
  await ipad.acceptPairing(invite)
  assert.equal(ipad.secret.home, alice.secret.home)
  assert.equal(ipad.secret.pointer, null)
  nodes.delete(alice)
  await alice.close() // the phone holding the pointer is lost

  const phone2 = await mk('phone2')
  const restored = await phone2.restoreIdentity(phrase)
  assert.equal(restored.key, pa.key)
  assert.equal(phone2.secret.home, ipad.secret.home)
  assert.equal(phone2.peers.has(pa.key), false, 'own hello not kept as a peer')
})

test('restore with allowNewHome: same identity, new base, pointer untouched, findable again', { timeout: 180000 }, async (t) => {
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap
  const nodes = new Set()
  const mk = async (name) => {
    const n = new HuwaNode({ storage: path.join(tmp, 'lost-' + name), bootstrap, deviceName: name, restoreLookupMs: 6000 })
    await n.ready()
    nodes.add(n)
    return n
  }
  const close = async (n) => {
    nodes.delete(n)
    await n.close()
  }
  t.after(async () => {
    for (const n of nodes) await n.close().catch(() => {})
    await testnet.destroy()
  })

  const alice = await mk('alice')
  const { profile: pa, phrase } = await alice.createIdentity('Alice')
  const homeA = alice.secret.home
  await close(alice) // the only device is gone (app deleted)

  const phone = await mk('phone')
  // Without the flag: refused, nothing written.
  await assert.rejects(phone.restoreIdentity(phrase), (err) => err.code === 'RESTORE_NOT_FOUND')
  assert.equal(phone.secret, null)
  // An invalid name is refused before anything happens.
  await assert.rejects(phone.restoreIdentity(phrase, { allowNewHome: true, name: 'x'.repeat(200) }), /Pseudo invalide/)
  assert.equal(phone.secret, null)

  const restored = await phone.restoreIdentity(phrase, { allowNewHome: true, name: 'Alice' })
  assert.equal(restored.key, pa.key, 'same identity key')
  assert.equal(restored.fingerprint, pa.fingerprint)
  assert.equal(restored.name, 'Alice', 'profile re-created with the given name')
  const homeNew = phone.secret.home
  assert.notEqual(homeNew, homeA, 'new personal base')
  assert.equal(phone.secret.pointer, null, 'does not serve the root pointer')
  assert.ok(phone.secret.lostHomeAt)
  assert.equal(phone.secret.previousPointer.length, 64)
  assert.equal((await phone.devices()).length, 1)
  // The root-owned pointer was not appended: no conflicting signed block for the old pointer.
  const { out } = await phone._deriveRoot(phrase.join(' '))
  const ptr = phone.store.get({ keyPair: out.pointer })
  await ptr.ready()
  assert.equal(ptr.length, 0, 'pointer not appended')
  await ptr.close()
  // The new account works: profile edits go to the new base.
  assert.equal((await phone.updateProfile({ bio: 'de retour' })).bio, 'de retour')

  // Another reinstall later, the old device still gone: the new base is found through the hello.
  const tablet = await mk('tablet')
  const again = await tablet.restoreIdentity(phrase)
  assert.equal(again.key, pa.key)
  assert.equal(tablet.secret.home, homeNew, 'joined the base created without old data')
  await close(tablet)

  // The old device comes back: nothing is merged, its base is recorded for a later reconciliation.
  const aliceBack = await mk('alice')
  assert.equal(aliceBack.secret.home, homeA)
  const deadline = Date.now() + 30000
  let seen = null
  while (Date.now() < deadline && !(seen = (await phone.local.get('restore/old-home'))?.value)) await new Promise((r) => setTimeout(r, 250))
  assert.equal(seen && seen.home, homeA, 'old base recorded')
  assert.equal(phone.secret.home, homeNew, 'still on its own base')
  assert.equal(aliceBack.me().name, 'Alice', 'old device keeps its data')
})

test('restore with allowNewHome while a device is online joins the existing base (no fork)', { timeout: 120000 }, async (t) => {
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap
  const nodes = new Set()
  const mk = async (name) => {
    const n = new HuwaNode({ storage: path.join(tmp, 'online-' + name), bootstrap, deviceName: name, restoreLookupMs: 8000 })
    await n.ready()
    nodes.add(n)
    return n
  }
  t.after(async () => {
    for (const n of nodes) await n.close().catch(() => {})
    await testnet.destroy()
  })

  const alice = await mk('alice')
  const { profile: pa, phrase } = await alice.createIdentity('Alice')
  const phone = await mk('phone')
  const restored = await phone.restoreIdentity(phrase, { allowNewHome: true, name: 'Autre nom' })
  assert.equal(restored.key, pa.key)
  assert.equal(phone.secret.home, alice.secret.home, 'existing base joined')
  assert.equal(phone.secret.lostHomeAt, undefined)
  assert.ok(phone.secret.pointer, 'normal restore: serves the pointer')
  const deadline = Date.now() + 20000
  while (Date.now() < deadline && !(phone.me() && phone.me().name === 'Alice')) await new Promise((r) => setTimeout(r, 200))
  assert.equal(phone.me() && phone.me().name, 'Alice', 'the given name is ignored when the account is found')
  assert.equal(alice.pointer.length, 1, 'pointer still has its single entry')
})
