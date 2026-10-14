#!/usr/bin/env node
// Huwa P2P gateway (spike S2): relays the HyperDHT to browsers over WebSocket with
// @hyperswarm/dht-relay, NON-CUSTODIAL ONLY. The browser keeps every secret key: it signs DHT
// announces and runs the Noise handshakes itself; this process only forwards ciphertext. Any
// handshake / connect / announce / unannounce carrying a secret key is refused and the client
// stream closed (a custodial client would have handed its key to the server).
//
//   node relay.js [--port 8080] [--host 127.0.0.1] [--bootstrap host:port,...] [--testnet 3]
//                 [--static dir] [--audit dir]
//
// --testnet N  starts a local HyperDHT testnet in this process (tests, spike) and prints it.
// --static     serves a directory over HTTP next to /p2p (spike page).
// --audit dir  keeps every byte received from browsers and exposes POST /__audit/dump and
//              /__audit/heap (raw inbound bytes, V8 heap snapshot) so a test can check that no
//              secret ever reached the relay. Never enable in production.
const { Buffer } = require('buffer')
const http = require('http')
const fs = require('fs')
const path = require('path')
const v8 = require('v8')
const { WebSocketServer } = require('ws')
const DHT = require('hyperdht')
const RelayStream = require('@hyperswarm/dht-relay/ws')

// Internals not exported by the package (pinned 0.4.3): needed to inspect the handshake.
const relayDir = path.dirname(require.resolve('@hyperswarm/dht-relay'))

// PATCH (dht-relay 0.4.3 vs hyperdht 6.34): hyperdht calls signAnnounce(target, token, id, ann)
// with ann = { peer: { publicKey, relayAddresses }, refresh, ... }, but SigneeProxy destructures
// `{ peer: relayAddresses }`, so it forwards the whole peer object as the relay address list: the
// browser's signature request fails to encode and every non-custodial announce (server.listen,
// swarm.join as server) hangs -> peers get PEER_NOT_FOUND. Patched before node-proxy.js and
// server-proxy.js load (they destructure the export at require time). The browser side signs
// ns || H(target, id, token, peer) as hyperdht does (refresh is always null when announcing).
{
  const signeeProxy = require(path.join(relayDir, 'lib', 'signee-proxy.js'))
  const Original = signeeProxy.SigneeProxy
  signeeProxy.SigneeProxy = class SigneeProxy extends Original {
    constructor(...args) {
      super(...args)
      const announce = this._signAnnounce
      const unannounce = this._signUnannounce
      const fix = (sign) => (target, token, peerId, ann) => {
        if (ann.refresh) return Promise.reject(new Error('refresh announces cannot be relayed'))
        return sign(target, token, peerId, { peer: (ann.peer && ann.peer.relayAddresses) || [] })
      }
      this._signAnnounce = fix(announce)
      this._signUnannounce = fix(unannounce)
    }
  }
}
const { Protocol } = require(path.join(relayDir, 'lib', 'protocol.js'))
const { NodeProxy } = require(path.join(relayDir, 'lib', 'node-proxy.js'))

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm' }

/** dht-relay's `relay()`, refusing custodial clients (secret keys sent to the server). */
function relayNonCustodial(dht, stream, stats) {
  const protocol = new Protocol(stream)
  let proxy = null
  const refuse = (what) => {
    stats.custodialRefused++
    stream.destroy(new Error('custodial ' + what + ' refused'))
  }
  // Registered before NodeProxy's own listeners: a custodial message closes the stream first.
  for (const ev of ['connect', 'announce', 'unannounce']) {
    protocol.on(ev, (m) => {
      if (m.custodial || m.secretKey) refuse(ev)
    })
  }
  protocol.once('handshake', (m) => {
    if (m.custodial || m.secretKey) return refuse('handshake')
    stats.handshakes++
    proxy = new NodeProxy(dht, protocol, { publicKey: m.publicKey, secretKey: null })
  })
  protocol.heartbeat()
  return () => proxy
}

async function startGateway({ port = 8080, host = '127.0.0.1', bootstrap, testnet = 0, staticDir = null, auditDir = null, log = console.log } = {}) {
  let net = null
  let dht
  if (testnet > 0) {
    const createTestnet = require('hyperdht/testnet')
    net = await createTestnet(testnet, { host: '127.0.0.1' })
    bootstrap = net.bootstrap
  }
  // Not testnet.createNode(): a server on that node (host pinned to 127.0.0.1) never gets the
  // holepunched stream on a local testnet, so relayed browsers could not accept connections.
  dht = new DHT({ bootstrap })
  await dht.ready()

  const stats = { connections: 0, handshakes: 0, custodialRefused: 0, inboundBytes: 0 }
  const inbound = auditDir ? [] : null

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, stats })
    if (req.url.startsWith('/p2p/mutable')) return mutable(dht, req, res, stats).catch((err) => send(res, 500, { error: err.message }))
    if (auditDir && req.method === 'POST' && req.url === '/__audit/dump') {
      const file = path.join(auditDir, 'relay-inbound-' + Date.now() + '.bin')
      fs.writeFileSync(file, Buffer.concat(inbound))
      return send(res, 200, { file, bytes: stats.inboundBytes, stats })
    }
    if (auditDir && req.method === 'POST' && req.url === '/__audit/heap') {
      if (global.gc) global.gc()
      const file = v8.writeHeapSnapshot(path.join(auditDir, 'relay-' + Date.now() + '.heapsnapshot'))
      return send(res, 200, { file, stats })
    }
    if (staticDir && req.method === 'GET') {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html'
      const file = path.join(staticDir, rel)
      if (!file.startsWith(staticDir + path.sep) && file !== staticDir) return send(res, 403, { error: 'forbidden' })
      return fs.readFile(file, (err, data) => {
        if (err) return send(res, 404, { error: 'not found' })
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
        res.end(data)
      })
    }
    send(res, 404, { error: 'not found' })
  })

  const wss = new WebSocketServer({ server, path: '/p2p', maxPayload: 4 * 1024 * 1024 })
  wss.on('connection', (socket) => {
    stats.connections++
    socket.on('message', (data) => {
      stats.inboundBytes += data.byteLength
      if (inbound) inbound.push(Buffer.from(data))
    })
    const stream = new RelayStream(false, socket)
    stream.on('error', (err) => log('relay stream error', err.message))
    relayNonCustodial(dht, stream, stats)
  })

  await new Promise((resolve) => server.listen(port, host, resolve))
  const addr = server.address()
  return {
    port: addr.port,
    host,
    bootstrap,
    stats,
    async close() {
      for (const c of wss.clients) c.terminate()
      wss.close()
      server.close()
      await dht.destroy()
      if (net) await net.destroy()
    }
  }
}

// Mutable DHT records for relayed browsers (dht-relay 0.4.3 has no mutablePut/mutableGet; blind
// pairing needs them). The browser signs; the gateway checks the signature and stores it as is
// (hyperdht's signMutable hook), so it never holds the key. Reads are verified by the browser too.
const Persistent = require('hyperdht/lib/persistent')
const HEX = /^[0-9a-f]*$/
async function mutable(dht, req, res, stats) {
  if (req.method === 'POST' && req.url === '/p2p/mutable') {
    const body = await readJson(req, 8192)
    const ok = body && HEX.test(body.publicKey) && body.publicKey.length === 64 && HEX.test(body.signature) && body.signature.length === 128 && HEX.test(body.value) && body.value.length <= 2000 && Number.isSafeInteger(body.seq) && body.seq >= 0
    if (!ok) return send(res, 400, { error: 'bad request' })
    const publicKey = Buffer.from(body.publicKey, 'hex')
    const value = Buffer.from(body.value, 'hex')
    const signature = Buffer.from(body.signature, 'hex')
    if (!Persistent.verifyMutable(signature, body.seq, value, publicKey)) return send(res, 403, { error: 'bad signature' })
    await dht.mutablePut({ publicKey }, value, { seq: body.seq, signMutable: () => signature })
    stats.mutablePuts = (stats.mutablePuts || 0) + 1
    return send(res, 200, { ok: true })
  }
  const m = /^\/p2p\/mutable\/([0-9a-f]{64})(\?.*)?$/.exec(req.url)
  if (req.method === 'GET' && m) {
    const q = new URL(req.url, 'http://x').searchParams
    const node = await dht.mutableGet(Buffer.from(m[1], 'hex'), { seq: Number(q.get('seq')) || 0, latest: q.get('latest') !== '0' })
    stats.mutableGets = (stats.mutableGets || 0) + 1
    return send(res, 200, node ? { seq: node.seq, value: node.value.toString('hex'), signature: node.signature.toString('hex') } : null)
  }
  send(res, 404, { error: 'not found' })
}

function readJson(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (d) => {
      size += d.byteLength
      if (size > max) {
        reject(new Error('too large'))
        req.destroy()
      } else chunks.push(d)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()))
      } catch {
        resolve(null)
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

module.exports = { startGateway, relayNonCustodial }

if (require.main === module) {
  const arg = (name, def) => {
    const i = process.argv.indexOf('--' + name)
    return i === -1 ? def : process.argv[i + 1]
  }
  const bootstrapArg = arg('bootstrap', null)
  startGateway({
    port: Number(arg('port', 8080)),
    host: arg('host', '127.0.0.1'),
    bootstrap: bootstrapArg ? bootstrapArg.split(',') : undefined,
    testnet: Number(arg('testnet', 0)),
    staticDir: arg('static', null) && path.resolve(arg('static')),
    auditDir: arg('audit', null) && path.resolve(arg('audit'))
  }).then((g) => {
    // One JSON line for the spike harness.
    console.log(JSON.stringify({ ready: true, port: g.port, bootstrap: g.bootstrap, pid: process.pid }))
    const stop = () => g.close().then(() => process.exit(0))
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}
