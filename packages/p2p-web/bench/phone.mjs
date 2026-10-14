// The "phone" of the reliability bench, in its own process: the real HuwaNode on native storage
// and plain UDP HyperDHT (as the app's Bare worklet runs it), plus the mobile link-web code path.
// Controlled over a small local HTTP API; prints {"ready":true,"port":…} when listening.
//   node bench/phone.mjs [--bootstrap host:port,...] [--dir path] [--name pseudo]
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..', '..', '..')
const require = createRequire(import.meta.url)
const { HuwaNode } = require(path.join(repo, 'src', 'p2p', 'worklet', 'node.js'))
const linkWeb = await import(path.join(repo, 'src', 'p2p', 'link-web.ts'))

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  return i === -1 ? def : process.argv[i + 1]
}
const bootstrap = arg('bootstrap', '')
  .split(',')
  .filter(Boolean)
  .map((s) => {
    const i = s.lastIndexOf(':')
    return { host: s.slice(0, i), port: Number(s.slice(i + 1)) }
  })
const dir = arg('dir', fs.mkdtempSync(path.join(os.tmpdir(), 'huwa-bench-phone-')))
const events = []
const node = new HuwaNode({ storage: dir, bootstrap: bootstrap.length ? bootstrap : undefined, deviceName: 'iPhone bench', log: (...a) => events.push([Date.now(), a.join(' ')]) })
await node.ready()
if (!node.me()) await node.createIdentity(arg('name', 'Bench'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const aead = {
  async seal(key, nonce, plaintext, aad) {
    const c = crypto.createCipheriv('aes-256-gcm', key, nonce)
    c.setAAD(aad)
    return new Uint8Array(Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]))
  }
}

const routes = {
  async me() {
    return { me: node.me(), peers: node.swarm.connections.size, firewalled: node.swarm.dht.firewalled, host: node.swarm.dht.host }
  },
  async answerQr({ url }) {
    const t = Date.now()
    const req = linkWeb.parseLinkUrl(url)
    const invite = await node.pairingInvite()
    const frame = await linkWeb.sealLinkFrame({ invite, name: 'iPhone bench', ts: Date.now() }, req, { aead, random: (n) => new Uint8Array(crypto.randomBytes(n)) })
    await linkWeb.postLinkFrame(req, frame)
    return { ms: Date.now() - t, name: req.name }
  },
  async devices() {
    return node.devices()
  },
  async comment({ work, text }) {
    const t = Date.now()
    const c = await node.postComment({ target: 'ep:' + work + '-e1', text, spoiler: false })
    return { ms: Date.now() - t, id: c.id }
  },
  async waitComment({ work, id, ms = 30000 }) {
    const t = Date.now()
    while (Date.now() - t < ms) {
      if ((await node.listComments(work)).some((c) => c.id === id)) return { ms: Date.now() - t }
      await sleep(100)
    }
    throw new Error('timeout waiting for comment ' + id)
  },
  async waitRevoked({ key, ms = 30000 }) {
    const t = Date.now()
    while (Date.now() - t < ms) {
      if ((await node.devices()).some((d) => d.key === key && d.revoked)) return { ms: Date.now() - t }
      await sleep(200)
    }
    throw new Error('timeout waiting for revocation')
  },
  async events({ since = 0 }) {
    return events.filter(([t]) => t >= since)
  }
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', async () => {
    try {
      const fn = routes[req.url.slice(1)]
      if (!fn) throw new Error('unknown route')
      const v = await fn(body ? JSON.parse(body) : {})
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, v }))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, e: String((err && err.stack) || err) }))
    }
  })
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, port: server.address().port, key: node.me().key })))
const stop = async () => {
  await node.close().catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
