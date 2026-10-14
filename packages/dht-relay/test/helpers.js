// Test rig: a local HyperDHT testnet, a relay server over WebSocket (ws) and relay clients.
const createTestnet = require('hyperdht/testnet')
const DHT = require('hyperdht')
const { WebSocketServer, WebSocket } = require('ws')

const RelayNode = require('..')
const Stream = require('../ws')

async function rig (t, relayOptions = {}) {
  const testnet = await createTestnet(3, { host: '127.0.0.1' })
  // A plain node, not testnet.createNode(): a server on a node pinned to 127.0.0.1 never gets the
  // holepunched stream on a local testnet.
  const dht = new DHT({ bootstrap: testnet.bootstrap })
  await dht.ready()

  const events = { refused: [], limits: [], proxies: [] }
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  wss.on('connection', (socket) => {
    const stream = new Stream(false, socket)
    stream.on('error', () => {})
    RelayNode.relay(dht, stream, {
      onrefuse: (w) => events.refused.push(w),
      onlimit: (w) => events.limits.push(w),
      ...relayOptions
    }).then((p) => events.proxies.push(p), () => {})
  })
  await new Promise((resolve) => wss.once('listening', resolve))
  const url = 'ws://127.0.0.1:' + wss.address().port

  const clients = []
  const plains = []

  function client (opts = {}) {
    const ws = new WebSocket(url)
    const node = new RelayNode(new Stream(true, ws), opts)
    node._ws = ws
    clients.push(node)
    return node
  }

  function plain () {
    const node = new DHT({ bootstrap: testnet.bootstrap })
    plains.push(node)
    return node
  }

  t.after(async () => {
    const quick = (p) => within(Promise.resolve(p).catch(() => {}), 5000, 'teardown').catch(() => {})
    for (const c of clients) await quick(c.destroy({ force: true }))
    for (const p of plains) await quick(p.destroy({ force: true }))
    for (const s of wss.clients) s.terminate()
    wss.close()
    await quick(dht.destroy({ force: true }))
    await quick(testnet.destroy())
  })

  return { testnet, dht, url, client, plain, events }
}

function closed (ws) {
  return new Promise((resolve) => {
    if (ws.readyState === 3) return resolve()
    ws.once('close', resolve)
  })
}

function within (promise, ms, what) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timeout: ' + what)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

module.exports = { rig, closed, within }
