// The "mobile" peer of spike S2: the real HuwaNode on native RocksDB (a directory) and plain UDP
// Hyperswarm, as the app's Bare worklet runs it. Controlled over a small local HTTP API.
//   node spike/mobile.mjs --bootstrap host:port,... --dir /tmp/x
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { HuwaNode } = require('../../../src/p2p/worklet/node.js')

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  return i === -1 ? def : process.argv[i + 1]
}
const bootstrap = arg('bootstrap', '').split(',').filter(Boolean).map((s) => {
  const [host, port] = s.split(':')
  return { host, port: Number(port) }
})
const node = new HuwaNode({ storage: arg('dir'), bootstrap, deviceName: 'mobile' })
await node.ready()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const routes = {
  async identity({ name }) {
    return node.createIdentity(name)
  },
  async invite() {
    return { invite: await node.pairingInvite() }
  },
  async profile(patch) {
    const t = Date.now()
    const me = await node.updateProfile(patch)
    return { ms: Date.now() - t, me }
  },
  async accept({ invite }) {
    const t = Date.now()
    const me = await node.acceptPairing(invite)
    return { ms: Date.now() - t, me }
  },
  async waitMe({ field, value, ms = 30000 }) {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const me = node.me()
      if (me && me[field] === value) return { ms: Date.now() - t }
      await sleep(50)
    }
    throw new Error('timeout waiting for me.' + field)
  },
  async me() {
    return { me: node.me() || null, peers: node.swarm.connections.size }
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
  }
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', async () => {
    const name = req.url.slice(1)
    try {
      if (!routes[name]) throw new Error('unknown route ' + name)
      const v = await routes[name](body ? JSON.parse(body) : {})
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, v }))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, e: err.stack || String(err) }))
    }
  })
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, port: server.address().port })))
const stop = async () => {
  await node.close().catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
