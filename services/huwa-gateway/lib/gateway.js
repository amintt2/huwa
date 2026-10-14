// Huwa P2P gateway: HyperDHT for browsers, NON-CUSTODIAL ONLY.
//
//   WS   /p2p                      @huwa/dht-relay (packages/dht-relay): the browser keeps every
//                                  secret key, signs its announces and mutable records and runs
//                                  Noise itself; this process forwards public keys, signatures
//                                  and ciphertext. A message carrying a secret key closes the socket.
//   GET  /p2p/health               liveness + counters (no per-user data)
//   POST /p2p/rendezvous/<topic>   QR "link a browser" mailbox (lib/rendezvous.js)
//   GET  /p2p/rendezvous/<topic>?after=<n>&wait=<ms>
//   DELETE /p2p/rendezvous/<topic>
//
// It runs as a child of huwa-server, on loopback (127.0.0.1:8081 by default); the server proxies
// /p2p to it (WebSocket upgrade included) and passes the client address in X-Forwarded-For.
const { Buffer } = require('buffer')
const http = require('http')
const fs = require('fs')
const path = require('path')
const v8 = require('v8')
const { WebSocketServer } = require('ws')
const DHT = require('hyperdht')
const RelayNode = require('@huwa/dht-relay')
const RelayStream = require('@huwa/dht-relay/ws')

const { Rendezvous } = require('./rendezvous')
const { DEFAULTS } = require('./config')

const VERSION = require('../package.json').version
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' }
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

function makeLogger(level, sink = console.log) {
  const max = LEVELS[level] ?? LEVELS.info
  const out = (lvl, msg, extra) => {
    if (LEVELS[lvl] > max) return
    sink(JSON.stringify({ t: new Date().toISOString(), lvl, msg, ...extra }))
  }
  return { error: (m, e) => out('error', m, e), warn: (m, e) => out('warn', m, e), info: (m, e) => out('info', m, e), debug: (m, e) => out('debug', m, e) }
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** Client address: the right-most X-Forwarded-For entry when the peer is huwa-server (loopback). */
function clientIp(req) {
  const peer = req.socket.remoteAddress || ''
  const xff = req.headers['x-forwarded-for']
  if (xff && isLoopback(peer)) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean)
    if (parts.length) return parts[parts.length - 1]
  }
  return peer
}

function originChecker(allowed, publicUrl) {
  const set = new Set()
  let any = false
  for (const o of allowed) {
    if (o === '*') any = true
    else if (o === 'self') {
      if (publicUrl) set.add(new URL(publicUrl).origin)
    } else {
      try {
        set.add(new URL(o).origin)
      } catch {
        // ignored: not an origin
      }
    }
  }
  return (origin, req) => {
    // Browsers always send Origin on WebSocket and cross-origin fetch; other clients (the phone
    // app, tests) are not bound by it anyway.
    if (!origin) return true
    if (any || set.has(origin)) return true
    // "self" without HUWA_PUBLIC_URL: the Host the request came in on.
    if (allowed.includes('self') && !publicUrl && req.headers.host) {
      const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
      const host = req.headers['x-forwarded-host'] || req.headers.host
      return origin === proto + '://' + host || origin === 'https://' + host || origin === 'http://' + host
    }
    return false
  }
}

class RateLimiter {
  constructor(perMinute) {
    this.perMinute = perMinute
    this.buckets = new Map()
  }

  take(key) {
    const now = Date.now()
    let b = this.buckets.get(key)
    if (!b) {
      b = { tokens: this.perMinute, at: now }
      this.buckets.set(key, b)
    }
    b.tokens = Math.min(this.perMinute, b.tokens + ((now - b.at) * this.perMinute) / 60000)
    b.at = now
    if (this.buckets.size > 10000) for (const [k, v] of this.buckets) if (v.tokens >= this.perMinute) this.buckets.delete(k)
    if (b.tokens < 1) return false
    b.tokens--
    return true
  }
}

async function startGateway(options = {}) {
  const c = { ...DEFAULTS, ...options }
  const log = c.logger || makeLogger(c.log)
  let testnet = null
  let bootstrap = c.bootstrap
  if (c.testnet > 0) {
    const createTestnet = require('hyperdht/testnet')
    testnet = await createTestnet(c.testnet, { host: '127.0.0.1' })
    bootstrap = testnet.bootstrap
  }
  // Long-lived node on a fixed UDP port (HUWA_DHT_PORT): once the operator forwards it, the node
  // is reachable, so phones behind NAT can always connect to the browsers it relays.
  // Not testnet.createNode(): a server on that node (pinned to 127.0.0.1) never gets the
  // holepunched stream on a local testnet.
  const dhtOpts = { bootstrap: bootstrap || undefined }
  if (!testnet) {
    dhtOpts.port = c.dhtPort
    dhtOpts.host = c.dhtHost
  }
  let dht
  try {
    dht = new DHT(dhtOpts)
    await dht.ready()
  } catch (err) {
    if (dht) await dht.destroy().catch(() => {})
    if (dhtOpts.port === 0) throw err
    // Port taken (another process): fall back to a random port rather than not starting at all.
    log.warn('dht port unavailable, using a random port', { port: dhtOpts.port, error: err.message })
    dht = new DHT({ ...dhtOpts, port: 0 })
    await dht.ready()
  }

  const rendezvous = new Rendezvous({ ttlMs: c.rendezvousTtlMs, frameBytes: c.rendezvousFrameBytes, framesPerTopic: c.rendezvousFramesPerTopic, maxTopics: c.rendezvousMaxTopics, maxWaitMs: c.rendezvousMaxWaitMs })
  const postLimiter = new RateLimiter(c.rendezvousPostsPerMinute)
  const getLimiter = new RateLimiter(c.rendezvousPostsPerMinute * 10)
  const allowOrigin = originChecker(c.allowedOrigins, c.publicUrl)
  const started = Date.now()
  const stats = { connections: 0, open: 0, handshakes: 0, refusedOrigin: 0, refusedCapacity: 0, refusedPerIp: 0, custodialRefused: 0, limits: 0, idleClosed: 0, inboundBytes: 0, outboundBytes: 0 }
  const perIp = new Map()
  const inbound = c.auditDir ? [] : null
  const sockets = new Set()

  const cors = (req, res) => {
    const origin = req.headers.origin
    if (origin && allowOrigin(origin, req)) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
      res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
      res.setHeader('access-control-allow-headers', 'content-type')
      res.setHeader('access-control-max-age', '600')
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error('request failed', { url: req.url.split('?')[0], error: err.message })
      if (!res.headersSent) send(res, 500, { error: 'internal error' })
    })
  })

  async function handle(req, res) {
    const url = new URL(req.url, 'http://gateway')
    const p = url.pathname
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')

    if (p === '/p2p/health' || p === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' })
      return send(res, 200, health())
    }

    if (p.startsWith('/p2p/rendezvous/')) {
      cors(req, res)
      if (req.headers.origin && !allowOrigin(req.headers.origin, req)) return send(res, 403, { error: 'origin not allowed' })
      if (req.method === 'OPTIONS') return res.writeHead(204).end()
      const topic = p.slice('/p2p/rendezvous/'.length)
      if (!Rendezvous.validTopic(topic)) return send(res, 400, { error: 'topic: 64 lowercase hex characters' })
      const ip = clientIp(req)
      if (req.method === 'POST') {
        if (!postLimiter.take(ip)) return send(res, 429, { error: 'too many requests' })
        const body = await readBody(req, c.rendezvousFrameBytes)
        if (body === null) return send(res, 413, { error: 'frame too large (max ' + c.rendezvousFrameBytes + ' bytes)' })
        try {
          const n = rendezvous.post(topic, body)
          return send(res, 201, { n, ttlMs: c.rendezvousTtlMs })
        } catch (err) {
          return send(res, err.status || 500, { error: err.message })
        }
      }
      if (req.method === 'GET') {
        if (!getLimiter.take(ip)) return send(res, 429, { error: 'too many requests' })
        const after = Number.isSafeInteger(Number(url.searchParams.get('after'))) && url.searchParams.has('after') ? Number(url.searchParams.get('after')) : -1
        const wait = Math.max(0, Math.min(Number(url.searchParams.get('wait')) || 0, c.rendezvousMaxWaitMs))
        const ac = new AbortController()
        req.on('close', () => ac.abort())
        const frames = await rendezvous.get(topic, after, wait, ac.signal)
        if (res.destroyed) return
        const next = frames.length ? frames[frames.length - 1].n : after
        return send(res, 200, { frames: frames.map((f) => ({ n: f.n, data: Buffer.from(f.data).toString('base64') })), next })
      }
      if (req.method === 'DELETE') {
        rendezvous.delete(topic)
        return res.writeHead(204).end()
      }
      return send(res, 405, { error: 'method not allowed' })
    }

    if (c.auditDir && req.method === 'POST' && p === '/__audit/dump') {
      const file = path.join(c.auditDir, 'relay-inbound-' + Date.now() + '.bin')
      fs.writeFileSync(file, Buffer.concat(inbound))
      return send(res, 200, { file, bytes: stats.inboundBytes, stats })
    }
    if (c.auditDir && req.method === 'POST' && p === '/__audit/heap') {
      if (global.gc) global.gc()
      const file = v8.writeHeapSnapshot(path.join(c.auditDir, 'gateway-' + Date.now() + '.heapsnapshot'))
      return send(res, 200, { file, stats })
    }
    if (c.staticDir && req.method === 'GET') return serveStatic(c.staticDir, p, res)
    send(res, 404, { error: 'not found' })
  }

  function health() {
    return {
      ok: !dht.destroyed,
      version: VERSION,
      uptimeS: Math.round((Date.now() - started) / 1000),
      ws: { open: stats.open, max: c.maxWs },
      dht: { host: dht.host, port: dht.port, firewalled: dht.firewalled, ephemeral: dht.ephemeral, online: dht.online !== false },
      rendezvous: { topics: rendezvous.size },
      stats: { ...stats, rendezvous: rendezvous.stats }
    }
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
    perMessageDeflate: false
  })

  server.on('upgrade', (req, socket, head) => {
    const p = new URL(req.url, 'http://gateway').pathname
    const reject = (code, reason) => {
      socket.write('HTTP/1.1 ' + code + ' ' + reason + '\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      socket.destroy()
    }
    if (p !== '/p2p' && p !== '/p2p/') return reject(404, 'Not Found')
    if (!allowOrigin(req.headers.origin, req)) {
      stats.refusedOrigin++
      return reject(403, 'Forbidden')
    }
    if (stats.open >= c.maxWs) {
      stats.refusedCapacity++
      return reject(503, 'Service Unavailable')
    }
    const ip = clientIp(req)
    if ((perIp.get(ip) || 0) >= c.wsPerIp) {
      stats.refusedPerIp++
      return reject(429, 'Too Many Requests')
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, ip))
  })

  function onSocket(ws, ip) {
    stats.connections++
    stats.open++
    perIp.set(ip, (perIp.get(ip) || 0) + 1)
    sockets.add(ws)
    ws.on('message', (data) => {
      stats.inboundBytes += data.byteLength
      if (inbound) inbound.push(Buffer.from(data))
    })
    const stream = new RelayStream(false, ws, { bytesPerSecond: c.wsBytesPerSec })
    stream.on('error', (err) => log.debug('relay stream error', { error: err.message }))
    let lastIn = Date.now()
    ws.on('message', () => (lastIn = Date.now()))
    // A client answers the relay's 15 s pings: silence means a dead or frozen tab.
    const idle = c.wsIdleMs > 0
      ? setInterval(() => {
          if (Date.now() - lastIn > c.wsIdleMs) {
            stats.idleClosed++
            ws.terminate()
          }
        }, Math.min(c.wsIdleMs, 15_000))
      : null
    ws.once('close', () => {
      if (idle) clearInterval(idle)
      sockets.delete(ws)
      stats.open--
      stats.outboundBytes += stream.bytesOut
      const n = (perIp.get(ip) || 1) - 1
      if (n <= 0) perIp.delete(ip)
      else perIp.set(ip, n)
    })
    RelayNode.relay(dht, stream, {
      limits: { maxConnections: c.wsMaxConnections, maxQueries: c.wsMaxQueries, mutablePerMinute: c.wsMutablePerMinute },
      onrefuse: (what) => {
        stats.custodialRefused++
        log.warn('custodial client refused', { what })
      },
      onlimit: (what) => {
        stats.limits++
        log.debug('client limit', { what })
      }
    }).then(
      () => stats.handshakes++,
      () => {}
    )
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(c.port, c.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const addr = server.address()
  log.info('gateway listening', { host: c.host, port: addr.port, dhtPort: dht.port, firewalled: dht.firewalled })

  return {
    port: addr.port,
    host: c.host,
    bootstrap,
    dht,
    stats,
    rendezvous,
    health,
    async close() {
      for (const s of sockets) s.terminate()
      wss.close()
      rendezvous.close()
      await new Promise((resolve) => server.close(() => resolve()))
      await dht.destroy()
      if (testnet) await testnet.destroy()
    }
  }
}

function serveStatic(dir, p, res) {
  const root = path.resolve(dir)
  const rel = decodeURIComponent(p).replace(/^\/+/, '') || 'index.html'
  const file = path.join(root, rel)
  if (!file.startsWith(root + path.sep)) return send(res, 403, { error: 'forbidden' })
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' })
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(data)
  })
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    const len = Number(req.headers['content-length'])
    if (Number.isFinite(len) && len > max) {
      req.resume()
      return resolve(null)
    }
    req.on('data', (d) => {
      size += d.byteLength
      if (size > max) {
        resolve(null)
        req.destroy()
      } else chunks.push(d)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function send(res, status, body) {
  if (res.headersSent) return res.end()
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

module.exports = { startGateway, clientIp, originChecker, makeLogger }
