// Same topology as the browser run, in Node: isolates relay/protocol issues from browser ones.
// "web" = HuwaNode on rocksdb-idb (fake-indexeddb) through the gateway's non-custodial dht-relay;
// "mobile" = HuwaNode on native storage and plain UDP Hyperswarm, in this process or (with
// --mobile-process) in its own process, as in the browser run. SODIUM_SHIM=1 uses the browser's
// sodium in Node.
//   node spike/node-relay-check.mjs [--mobile-process] [--runs N]
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
require('../test/register.cjs')
const { startGateway } = require('../../../services/huwa-gateway/relay.js')
const { HuwaNode } = require('../../../src/p2p/worklet/node.js')
const RocksDB = require('../index.js')
const CorestoreStorage = require('hypercore-storage')
const { createRelaySwarmFactory } = require('./relay-swarm.js')
const { WebSocket } = require('ws')

const here = path.dirname(fileURLToPath(import.meta.url))
const separate = process.argv.includes('--mobile-process')
const runsArg = process.argv.indexOf('--runs')
const runs = runsArg === -1 ? 1 : Number(process.argv[runsArg + 1])
const log = (who) => (...a) => process.env.S2_VERBOSE && console.log('[' + who + ']', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function mobileInProcess(dir, bootstrap) {
  const node = new HuwaNode({ storage: dir, bootstrap, deviceName: 'mobile', log: log('mobile') })
  await node.ready()
  return {
    identity: (name) => node.createIdentity(name),
    invite: () => node.pairingInvite(),
    profile: (patch) => node.updateProfile(patch),
    hasComment: async (work, id) => (await node.listComments(work)).some((x) => x.id === id),
    close: () => node.close()
  }
}

async function mobileProcess(dir, bootstrap) {
  const child = spawn('node', [path.join(here, 'mobile.mjs'), '--bootstrap', bootstrap.map((b) => b.host + ':' + b.port).join(','), '--dir', dir], { stdio: ['ignore', 'pipe', 'inherit'] })
  const { port } = await new Promise((resolve) => readline.createInterface({ input: child.stdout }).on('line', (l) => l.startsWith('{"ready"') && resolve(JSON.parse(l))))
  const post = async (route, body = {}) => {
    const json = await (await fetch('http://127.0.0.1:' + port + '/' + route, { method: 'POST', body: JSON.stringify(body) })).json()
    if (json.ok === false) throw new Error(route + ': ' + json.e)
    return json.v
  }
  return {
    identity: (name) => post('identity', { name }),
    invite: async () => (await post('invite')).invite,
    profile: (patch) => post('profile', patch),
    hasComment: async (work, id) => {
      try {
        await post('waitComment', { work, id, ms: 100 })
        return true
      } catch {
        return false
      }
    },
    close: async () => child.kill('SIGTERM')
  }
}

async function once() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huwa-s2n-'))
  const gw = await startGateway({ port: 0, testnet: 3, log: () => {} })
  const relay = 'ws://127.0.0.1:' + gw.port + '/p2p'
  const mobile = await (separate ? mobileProcess : mobileInProcess)(path.join(tmp, 'mobile'), gw.bootstrap)
  const web = new HuwaNode({ storage: new CorestoreStorage(new RocksDB('s2n-' + Date.now())), swarmFactory: createRelaySwarmFactory({ url: relay, WebSocket }), deviceName: 'web', log: log('web') })
  const out = {}
  try {
    await web.ready()
    const { profile } = await mobile.identity('Mobile')
    const invite = await mobile.invite()
    let t = Date.now()
    const me = await web.acceptPairing(invite)
    out.pairingMs = Date.now() - t
    out.same = me.key === profile.key
    t = Date.now()
    await mobile.profile({ bio: 'x' })
    while (!web.me() || web.me().bio !== 'x') {
      if (Date.now() - t > 30000) throw new Error('home base did not replicate in 30 s')
      await sleep(50)
    }
    out.homeMs = Date.now() - t
    t = Date.now()
    const c = await web.postComment({ target: 'ep:4242-e1', text: 'depuis web', spoiler: false })
    out.webCommentAppendMs = Date.now() - t
    while (!(await mobile.hasComment('4242', c.id))) {
      if (Date.now() - t > 30000) throw new Error('comment did not replicate in 30 s')
      await sleep(100)
    }
    out.commentWebToPhoneMs = Date.now() - t
    out.gateway = gw.stats
    console.log(JSON.stringify(out))
    return true
  } catch (err) {
    console.log('FAILED', err.message, JSON.stringify(out))
    return false
  } finally {
    await web.close().catch(() => {})
    await mobile.close().catch(() => {})
    await gw.close()
  }
}

let ok = 0
for (let i = 0; i < runs; i++) if (await once()) ok++
console.log('ok', ok + '/' + runs, separate ? '(mobile in its own process)' : '(mobile in process)')
process.exitCode = ok === runs ? 0 : 1
