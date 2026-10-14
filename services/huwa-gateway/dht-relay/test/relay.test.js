// Huwa fork of @hyperswarm/dht-relay: the fixes listed in README.md, against hyperdht 6.34.
const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const DHT = require('hyperdht')
const Persistent = require('hyperdht/lib/persistent')
const { NS } = require('hyperdht/lib/constants')
const Hyperswarm = require('hyperswarm')
const { WebSocket } = require('ws')

const RelayNode = require('..')
const Stream = require('../ws')
const { Protocol } = require('../lib/protocol')
const { signable } = require('../lib/signee')
const { signMutable, verifyMutable } = require('../lib/mutable')
const { relayAddressesOf } = require('../lib/signee-proxy')
const { rig, closed, within } = require('./helpers')

const quietSocket = (url) => {
  const ws = new WebSocket(url)
  ws.on('error', () => {})
  return ws
}

const hash = (s) => {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.from(s))
  return out
}

test('announce signable is byte-identical to hyperdht 6.34 (Persistent.signAnnounce)', () => {
  const keyPair = DHT.keyPair()
  const target = hash('topic')
  const token = hash('token')
  const id = hash('node id')
  for (const relayAddresses of [[], [{ host: '1.2.3.4', port: 4000 }]]) {
    const ann = { peer: { publicKey: keyPair.publicKey, relayAddresses }, refresh: null, bump: 0 }
    const theirs = Persistent.signAnnounce(target, token, id, ann, keyPair)
    const sig = b4a.alloc(64)
    sodium.crypto_sign_detached(sig, signable(keyPair.publicKey, target, token, id, relayAddresses, NS.ANNOUNCE), keyPair.secretKey)
    assert.ok(b4a.equals(sig, theirs), 'announce signature')
    const theirsUn = Persistent.signUnannounce(target, token, id, ann, keyPair)
    sodium.crypto_sign_detached(sig, signable(keyPair.publicKey, target, token, id, relayAddresses, NS.UNANNOUNCE), keyPair.secretKey)
    assert.ok(b4a.equals(sig, theirsUn), 'unannounce signature')
  }
  // The proxy reads the hyperdht 6 announce shape (and still the hyperdht 5 one).
  const addrs = [{ host: '5.6.7.8', port: 1 }]
  assert.deepEqual(relayAddressesOf({ peer: { publicKey: keyPair.publicKey, relayAddresses: addrs } }), addrs)
  assert.deepEqual(relayAddressesOf({ peer: addrs }), addrs)
  assert.deepEqual(relayAddressesOf({ peer: { publicKey: keyPair.publicKey } }), [])
})

test('non-custodial announce reaches real hyperdht nodes; lookup finds it; query.finished() without a reader', async (t) => {
  const { client, plain } = await rig(t)
  const node = client()
  await node.ready()
  const topic = hash('huwa/test/announce')
  const keyPair = RelayNode.keyPair()
  // blind-pairing awaits `announce(...).finished()` and never reads the query.
  await within(node.announce(topic, keyPair).finished(), 20000, 'announce finished')

  const other = plain()
  await other.ready()
  const found = []
  for await (const data of other.lookup(topic)) for (const p of data.peers) found.push(b4a.toString(p.publicKey, 'hex'))
  assert.ok(found.includes(b4a.toString(keyPair.publicKey, 'hex')), 'announced key found by a plain HyperDHT node')

  await within(node.lookup(topic).finished(), 20000, 'lookup finished')
  await within(node.unannounce(topic, keyPair), 20000, 'unannounce')
})

test('relayed server (browser side) accepts a plain hyperdht client; rawStream.rtt is a number', async (t) => {
  const { client, plain } = await rig(t)
  const node = client()
  const server = node.createServer()
  const serverConn = new Promise((resolve) => server.on('connection', (c) => {
    c.on('error', () => {})
    c.once('data', (d) => resolve([c, d]))
  }))
  const keyPair = RelayNode.keyPair()
  await within(server.listen(keyPair), 20000, 'listen')

  const other = plain()
  await other.ready()
  const conn = other.connect(keyPair.publicKey)
  conn.on('error', () => {})
  conn.write(b4a.from('ping'))
  const [inbound, got] = await within(serverConn, 20000, 'server connection')
  assert.equal(b4a.toString(got), 'ping')
  assert.equal(typeof inbound.rawStream.rtt, 'number')
  assert.ok(b4a.equals(inbound.remotePublicKey, conn.publicKey))
  conn.destroy()
})

test('relayed client connects to a plain hyperdht server (Noise runs in the client)', async (t) => {
  const { client, plain } = await rig(t)
  const other = plain()
  const keyPair = DHT.keyPair()
  const srv = other.createServer((c) => {
    c.on('error', () => {})
    c.on('data', (d) => c.write(b4a.concat([b4a.from('echo:'), d])))
  })
  await srv.listen(keyPair)

  const node = client()
  const conn = node.connect(keyPair.publicKey)
  conn.on('error', () => {})
  conn.write(b4a.from('hi'))
  const got = await within(new Promise((resolve) => conn.once('data', resolve)), 20000, 'echo')
  assert.equal(b4a.toString(got), 'echo:hi')
  assert.equal(conn.rawStream.rtt, 0)
  conn.destroy()
})

test('mutablePut / mutableGet: signed in the client, verified by the relay, readable by plain nodes', async (t) => {
  const { client, plain } = await rig(t)
  const node = client()
  await node.ready()
  const other = plain()
  await other.ready()

  const keyPair = DHT.keyPair()
  const put = await within(node.mutablePut(keyPair, b4a.from('from the browser'), { seq: 3 }), 20000, 'mutablePut')
  assert.equal(put.seq, 3)
  const seen = await other.mutableGet(keyPair.publicKey, { latest: false })
  assert.ok(seen && b4a.toString(seen.value) === 'from the browser' && seen.seq === 3)

  const theirs = DHT.keyPair()
  await other.mutablePut(theirs, b4a.from('from a phone'))
  const got = await within(node.mutableGet(theirs.publicKey, { latest: false }), 20000, 'mutableGet')
  assert.equal(b4a.toString(got.value), 'from a phone')
  assert.equal(await node.mutableGet(DHT.keyPair().publicKey), null, 'missing record is null')

  // A keyPair that only exposes sign() (no secret key at all) works too.
  const signer = DHT.keyPair()
  const signOnly = { publicKey: signer.publicKey, sign: (m) => { const s = b4a.alloc(64); sodium.crypto_sign_detached(s, m, signer.secretKey); return s } }
  await node.mutablePut(signOnly, b4a.from('sign only'))
  assert.equal(b4a.toString((await other.mutableGet(signer.publicKey)).value), 'sign only')
})

test('the relay refuses badly signed and oversized mutable records', async (t) => {
  const { url } = await rig(t)
  const ws = quietSocket(url)
  const stream = new Stream(true, ws)
  const protocol = new Protocol(stream)
  const kp = DHT.keyPair()
  protocol.handshake.send({ custodial: false, publicKey: kp.publicKey, secretKey: null })
  const replies = []
  protocol.on('mutablePutReply', (m) => replies.push(m))
  const value = b4a.from('x')
  const good = await signMutable(0, value, kp)
  const bad = b4a.from(good)
  bad[0] ^= 1
  protocol.mutablePut.send({ id: 1, publicKey: kp.publicKey, seq: 0, value, signature: bad })
  const big = b4a.alloc(1001)
  protocol.mutablePut.send({ id: 2, publicKey: kp.publicKey, seq: 0, value: big, signature: await signMutable(0, big, kp) })
  await within((async () => { while (replies.length < 2) await new Promise((r) => setTimeout(r, 20)) })(), 10000, 'replies')
  assert.equal(replies.find((r) => r.id === 1).error, 'Bad signature')
  assert.equal(replies.find((r) => r.id === 2).error, 'Value too large')
  assert.ok(verifyMutable(good, 0, value, kp.publicKey))
  assert.equal(verifyMutable(bad, 0, value, kp.publicKey), false)
  stream.destroy()
})

test('Hyperswarm 4 over the relay: suspend / resume / online / lookupAndUnannounce stand-ins, replication both ways', async (t) => {
  const { client, testnet } = await rig(t)
  const dht = client()
  assert.equal(dht.destroyed, false)
  assert.equal(dht.online, true)
  const browser = new Hyperswarm({ dht, keyPair: dht.defaultKeyPair })
  const phone = new Hyperswarm({ bootstrap: testnet.bootstrap })
  for (const s of [browser, phone]) s.on('connection', (c) => c.on('error', () => {}))

  const topic = hash('huwa/test/swarm')
  const got = new Promise((resolve) => browser.on('connection', (c) => c.once('data', (d) => resolve(b4a.toString(d)))))
  phone.on('connection', (c) => c.write(b4a.from('hello browser')))
  browser.on('connection', (c) => assert.equal(typeof c.rawStream.rtt, 'number'))
  // Browser as server and client (Huwa joins topics both ways).
  await within(browser.join(topic, { server: true, client: true }).flushed(), 30000, 'browser join')
  phone.join(topic, { server: false, client: true })
  assert.equal(await within(got, 30000, 'phone -> browser'), 'hello browser')

  await browser.suspend()
  assert.equal(dht.suspended, true)
  await browser.resume()
  assert.equal(dht.suspended, false)
  const q = dht.lookupAndUnannounce(topic, dht.defaultKeyPair)
  await within(q.finished(), 20000, 'lookupAndUnannounce')
  await Promise.all([browser.destroy(), phone.destroy()])
})

test('custodial clients are refused and their secret key is wiped', async (t) => {
  const { url, events } = await rig(t)
  // 1. custodial handshake (what upstream clients do by default)
  const ws = quietSocket(url)
  const custodial = new RelayNode(new Stream(true, ws), { custodial: true })
  custodial.on('error', () => {})
  await within(closed(ws), 5000, 'custodial handshake closed')
  assert.ok(events.refused.includes('custodial:handshake'))

  // 2. non-custodial handshake, then a custodial connect / listen / announce
  for (const name of ['connect', 'listen', 'announce']) {
    const ws2 = quietSocket(url)
    const protocol = new Protocol(new Stream(true, ws2))
    const kp = DHT.keyPair()
    protocol.handshake.send({ custodial: false, publicKey: kp.publicKey, secretKey: null })
    const msg = { custodial: true, alias: 1, id: 1, topic: hash('t'), publicKey: kp.publicKey, secretKey: kp.secretKey, remotePublicKey: DHT.keyPair().publicKey }
    protocol[name].send(msg)
    await within(closed(ws2), 5000, 'custodial ' + name + ' closed')
    assert.ok(events.refused.includes('custodial:' + name), name)
  }

  // 3. the default client of this fork is non-custodial
  const ws3 = quietSocket(url)
  const fine = new RelayNode(new Stream(true, ws3))
  assert.equal(fine._custodial, false)
  await fine.ready()
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(ws3.readyState, 1, 'non-custodial client stays connected')
  await fine.destroy()
})

test('per-client query limit', async (t) => {
  const { client, events } = await rig(t, { limits: { maxQueries: 1 } })
  const node = client()
  await node.ready()
  const a = node.lookup(hash('a'))
  const b = node.lookup(hash('b'))
  await within(b.finished(), 5000, 'refused query finishes at once')
  assert.ok(events.limits.includes('queries'))
  a.destroy()
})

test('a duplicate Noise reply (hyperdht races several DHT nodes) is denied, not thrown', () => {
  const { Handshake } = require('../lib/handshake')
  const sent = []
  const protocol = { noiseReply: { send: (m) => sent.push(m) } }
  const node = { _handshakes: new Map() }
  const server = DHT.keyPair()
  const client = DHT.keyPair()
  const ini = new Handshake(node, protocol, null, 1, true, client, server.publicKey)
  const res = new Handshake(node, protocol, null, 2, false, server, null)
  ini._onNoiseSend({ payload: b4a.alloc(0) })
  res._onNoiseReceive({ payload: sent.at(-1).payload })
  res._onNoiseSend({ payload: b4a.alloc(0) })
  const reply = sent.at(-1).payload
  ini._onNoiseReceive({ payload: reply })
  assert.equal(sent.at(-1).complete, true)
  // The same reply again (from a second DHT node): no exception, a denied (empty) answer.
  assert.doesNotThrow(() => ini._onNoiseReceive({ payload: reply }))
  assert.equal(sent.at(-1).payload, null)
})

test('a throwing message handler does not freeze the relay protocol', async (t) => {
  const { client } = await rig(t)
  const node = client()
  await node.ready()
  node._protocol.once('finished', () => {
    throw new Error('boom')
  })
  const topic = hash('huwa/test/handler-error')
  await within(node.lookup(topic).finished(), 20000, 'first lookup (its handler throws)')
  await within(node.announce(topic, RelayNode.keyPair()).finished(), 20000, 'announce after a handler error')
  await within(node.lookup(topic).finished(), 20000, 'lookup after a handler error')
})

test('listening twice with one key pair: the relay retries, then reports listenError instead of hanging', async (t) => {
  const { client } = await rig(t)
  const a = client()
  const b = client()
  const keyPair = RelayNode.keyPair()
  await within(a.createServer().listen(keyPair), 20000, 'first listen')
  const second = b.createServer()
  await assert.rejects(within(second.listen(keyPair), 20000, 'second listen'), /KEYPAIR_ALREADY_USED/)
  await within(second.close(), 5000, 'close after listenError')
})
