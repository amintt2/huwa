const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { WebSocket } = require('ws')
const RelayNode = require('../dht-relay')
const RelayStream = require('../dht-relay/ws')
const { startGateway } = require('..')
const { fromEnv } = require('../lib/config')

const quiet = { error() {}, warn() {}, info() {}, debug() {} }

async function gateway(t, opts = {}) {
  const g = await startGateway({ port: 0, testnet: 2, logger: quiet, ...opts })
  t.after(() => g.close())
  return { g, base: 'http://127.0.0.1:' + g.port, ws: 'ws://127.0.0.1:' + g.port + '/p2p' }
}

function open(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers })
    ws.on('open', () => resolve({ ok: true, ws }))
    ws.on('unexpected-response', (req, res) => resolve({ ok: false, status: res.statusCode }))
    ws.on('error', () => resolve({ ok: false, status: 0 }))
  })
}

const topic = () => crypto.randomBytes(32).toString('hex')

test('config from the environment', () => {
  const c = fromEnv({ HUWA_GATEWAY_PORT: '9000', HUWA_MAX_WS: '3', HUWA_ALLOWED_ORIGINS: 'self, https://a.example', HUWA_BOOTSTRAP: '1.2.3.4:49737,[::1]:5', HUWA_GATEWAY_DHT_PORT: '40000', HUWA_DHT_PORT: '49737' }, [])
  assert.equal(c.port, 9000)
  assert.equal(c.host, '127.0.0.1')
  assert.equal(c.maxWs, 3)
  assert.deepEqual(c.allowedOrigins, ['self', 'https://a.example'])
  assert.deepEqual(c.bootstrap, [{ host: '1.2.3.4', port: 49737 }, { host: '[::1]', port: 5 }])
  assert.equal(c.dhtPort, 40000)
  const d = fromEnv({}, [])
  assert.equal(d.port, 8081)
  assert.deepEqual(d.allowedOrigins, ['self', 'https://huwa.mciut.fr'])
})

test('health', async (t) => {
  const { base } = await gateway(t)
  const res = await fetch(base + '/p2p/health')
  assert.equal(res.status, 200)
  const h = await res.json()
  assert.equal(h.ok, true)
  assert.equal(typeof h.dht.port, 'number')
  assert.equal(h.ws.max, 200)
})

test('origin allowlist on the WebSocket', async (t) => {
  const { ws } = await gateway(t, { publicUrl: 'https://huwa.example.org', allowedOrigins: ['self', 'https://huwa.mciut.fr'] })
  for (const [origin, ok] of [['https://huwa.example.org', true], ['https://huwa.mciut.fr', true], ['https://evil.example', false], [undefined, true]]) {
    const r = await open(ws, origin ? { origin } : {})
    assert.equal(r.ok, ok, String(origin))
    if (!ok) assert.equal(r.status, 403)
    if (r.ws) r.ws.terminate()
  }
})

test('"self" without HUWA_PUBLIC_URL is the Host the request came in on', async (t) => {
  const { ws, g } = await gateway(t, { allowedOrigins: ['self'] })
  assert.equal((await open(ws, { origin: 'http://127.0.0.1:' + g.port })).ok, true)
  assert.equal((await open(ws, { origin: 'https://huwa.mciut.fr' })).ok, false)
})

test('HUWA_MAX_WS and per-IP limits (X-Forwarded-For from huwa-server)', async (t) => {
  const { ws } = await gateway(t, { maxWs: 3, wsPerIp: 2 })
  const a = await open(ws, { 'x-forwarded-for': '203.0.113.1' })
  const b = await open(ws, { 'x-forwarded-for': '203.0.113.1' })
  const c = await open(ws, { 'x-forwarded-for': '203.0.113.1' })
  assert.ok(a.ok && b.ok)
  assert.equal(c.status, 429, 'third socket from the same client')
  const d = await open(ws, { 'x-forwarded-for': '203.0.113.2' })
  assert.ok(d.ok)
  const e = await open(ws, { 'x-forwarded-for': '203.0.113.3' })
  assert.equal(e.status, 503, 'gateway full')
  for (const r of [a, b, d]) r.ws.terminate()
})

test('idle sockets are closed', async (t) => {
  const { ws, g } = await gateway(t, { wsIdleMs: 400 })
  const r = await open(ws)
  // A raw socket that never answers the relay pings.
  const closed = new Promise((resolve) => r.ws.on('close', resolve))
  await closed
  assert.ok(g.stats.idleClosed >= 1)
})

test('custodial dht-relay clients are refused; non-custodial clients work', async (t) => {
  const { ws, g } = await gateway(t)
  const sock = new WebSocket(ws)
  sock.on('error', () => {})
  const closed = new Promise((resolve) => sock.on('close', resolve))
  const node = new RelayNode(new RelayStream(true, sock), { custodial: true })
  node.on('error', () => {})
  await closed
  assert.equal(g.stats.custodialRefused, 1)

  const sock2 = new WebSocket(ws)
  const fine = new RelayNode(new RelayStream(true, sock2))
  await fine.ready()
  const kp = RelayNode.keyPair()
  await fine.announce(crypto.randomBytes(32), kp).finished()
  assert.equal(sock2.readyState, 1)
  await fine.destroy()
})

test('rendezvous: post, long-poll, cursor, delete', async (t) => {
  const { base } = await gateway(t)
  const tp = topic()
  // The browser waits first...
  const t0 = Date.now()
  const waiting = fetch(base + '/p2p/rendezvous/' + tp + '?wait=5000').then((r) => r.json())
  await new Promise((resolve) => setTimeout(resolve, 200))
  // ...the phone posts a sealed frame.
  const frame = crypto.randomBytes(600)
  const post = await fetch(base + '/p2p/rendezvous/' + tp, { method: 'POST', body: frame })
  assert.equal(post.status, 201)
  const got = await waiting
  assert.ok(Date.now() - t0 < 4000, 'long-poll woke up')
  assert.equal(got.frames.length, 1)
  assert.equal(Buffer.from(got.frames[0].data, 'base64').toString('hex'), frame.toString('hex'))
  const again = await (await fetch(base + '/p2p/rendezvous/' + tp + '?after=' + got.next)).json()
  assert.equal(again.frames.length, 0)
  assert.equal((await fetch(base + '/p2p/rendezvous/' + tp, { method: 'DELETE' })).status, 204)
  assert.equal((await (await fetch(base + '/p2p/rendezvous/' + tp)).json()).frames.length, 0)
})

test('rendezvous limits: 8 KB frames, frames per topic, topic format, TTL', async (t) => {
  const { base } = await gateway(t, { rendezvousTtlMs: 600, rendezvousFramesPerTopic: 2 })
  const tp = topic()
  assert.equal((await fetch(base + '/p2p/rendezvous/' + tp, { method: 'POST', body: Buffer.alloc(8193) })).status, 413)
  assert.equal((await fetch(base + '/p2p/rendezvous/' + tp, { method: 'POST', body: Buffer.alloc(8192, 1) })).status, 201)
  assert.equal((await fetch(base + '/p2p/rendezvous/' + tp, { method: 'POST', body: Buffer.alloc(10, 1) })).status, 201)
  assert.equal((await fetch(base + '/p2p/rendezvous/' + tp, { method: 'POST', body: Buffer.alloc(10, 1) })).status, 429)
  assert.equal((await fetch(base + '/p2p/rendezvous/not-a-topic', { method: 'POST', body: 'x' })).status, 400)
  assert.equal((await fetch(base + '/p2p/rendezvous/' + tp.toUpperCase())).status, 400)
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal((await (await fetch(base + '/p2p/rendezvous/' + tp)).json()).frames.length, 0, 'expired')
})

test('rendezvous CORS follows the origin allowlist', async (t) => {
  const { base } = await gateway(t, { allowedOrigins: ['https://huwa.mciut.fr'] })
  const tp = topic()
  const ok = await fetch(base + '/p2p/rendezvous/' + tp, { headers: { origin: 'https://huwa.mciut.fr' } })
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://huwa.mciut.fr')
  const pre = await fetch(base + '/p2p/rendezvous/' + tp, { method: 'OPTIONS', headers: { origin: 'https://huwa.mciut.fr', 'access-control-request-method': 'POST' } })
  assert.equal(pre.status, 204)
  const bad = await fetch(base + '/p2p/rendezvous/' + tp, { headers: { origin: 'https://evil.example' } })
  assert.equal(bad.status, 403)
})
