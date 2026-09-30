#!/usr/bin/env node
// Desktop test peer running the exact worklet code under Node (second instance for the spike).
//
//   node scripts/p2p-peer.mjs --testnet 49737            # local DHT bootstrap on 127.0.0.1:49737 + peer
//   node scripts/p2p-peer.mjs --bootstrap 127.0.0.1:49737 # peer only, custom bootstrap
//   node scripts/p2p-peer.mjs                             # peer on the public Holepunch DHT
//
// Options: --work <seriesId> (default 424242), --storage <dir>, --name <pseudo>, --every <s>.
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import worklet from '../src/p2p/worklet/node.js'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf('--' + name)
  return i === -1 ? def : args[i + 1]
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)

let bootstrap = opt('bootstrap') ? opt('bootstrap').split(',') : undefined
let testnet = null
if (args.includes('--testnet')) {
  const port = Number(opt('testnet', 49737))
  testnet = await createTestnet(3, { port })
  bootstrap = testnet.bootstrap.map((b) => `${b.host}:${b.port}`)
  log('testnet DHT bootstrap', bootstrap.join(','))
}

const work = opt('work', '424242')
const storage = opt('storage', path.join(os.tmpdir(), 'huwa-peer-' + (opt('name') || 'desktop')))
const every = Number(opt('every', 20)) * 1000

const node = new worklet.HuwaNode({ storage, bootstrap, deviceName: 'desktop', log: (...a) => log('[node]', ...a) })
await node.ready()
let me = node.me()
if (!me) me = (await node.createIdentity(opt('name') || 'Desktop')).profile
log('identity', me.key, me.name, me.fingerprint)

const seen = new Set()
node.watch('comments', work, (all) => {
  for (const c of all) {
    if (seen.has(c.id)) continue
    seen.add(c.id)
    log(c.author === me.key ? 'local  ' : 'DISTANT', c.authorName, JSON.stringify(c.text), 'latence', Date.now() - c.createdAt, 'ms')
  }
})
setInterval(() => log('peers', node.status().peers), 10000).unref()

let n = 0
const post = async () => {
  try {
    const c = await node.postComment({ target: `ep:${work}-e1`, text: `desktop #${++n}`, spoiler: false })
    log('posted', c.id)
  } catch (err) {
    log('post failed', err.message)
  }
}
await post()
const timer = setInterval(post, every)

process.on('SIGINT', async () => {
  clearInterval(timer)
  await node.close()
  if (testnet) await testnet.destroy()
  process.exit(0)
})
