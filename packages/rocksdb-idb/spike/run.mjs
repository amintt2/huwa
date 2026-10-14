// Spike S2 harness (docs/p2p-browser-spike.md): headless Chromium (Playwright) runs the Huwa node
// in a Worker on rocksdb-idb, through the non-custodial gateway (services/huwa-gateway), against a
// "mobile" HuwaNode on native storage, over a local HyperDHT testnet. Writes spike/results.json.
//   cd packages/rocksdb-idb && node spike/run.mjs [--headed]
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import readline from 'node:readline'
import { chromium } from 'playwright'
import { bundle } from './build.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.join(here, '..')
const repo = path.join(pkg, '..', '..')
const require = createRequire(path.join(pkg, 'package.json'))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huwa-s2-'))
const results = { date: new Date().toISOString(), node: process.version }
const children = []
let browser = null
let gwInProc = null
const step = (s) => console.log('\n## ' + s)

function start(cmd, args, name) {
  const child = spawn(cmd, args, { cwd: pkg, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  child.stderr.on('data', (d) => process.stderr.write('[' + name + '] ' + d))
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (line.startsWith('{"ready"')) resolve(JSON.parse(line))
      else if (process.env.S2_VERBOSE) console.log('[' + name + ']', line)
    })
    child.on('exit', (code) => reject(new Error(name + ' exited ' + code)))
  })
}

async function post(port, route, body = {}) {
  const res = await fetch('http://127.0.0.1:' + port + '/' + route, { method: 'POST', body: JSON.stringify(body) })
  const json = await res.json()
  if (json.ok === false) throw new Error(route + ': ' + json.e)
  return json.v !== undefined ? json.v : json
}

async function main() {
  step('bundle')
  const { sizes } = await bundle({ minify: true })
  results.bundle = sizes
  console.log(JSON.stringify({ bytes: sizes.bytes, gzip: sizes.gzip, brotli: sizes.brotli }))

  step('gateway + testnet, mobile peer')
  // S2_GW_INPROC=1: gateway in this process (diagnostics only: the audit needs it in its own process)
  const gw = process.env.S2_GW_INPROC ? await require(path.join(repo, 'services', 'huwa-gateway', 'relay.js')).startGateway({ port: 0, testnet: 3, staticDir: here, auditDir: tmp, log: () => {} }) : await start('node', ['--expose-gc', path.join(repo, 'services', 'huwa-gateway', 'relay.js'), '--port', '0', '--testnet', '3', '--static', here, '--audit', tmp], 'gateway')
  if (gw.close) gwInProc = gw
  const bootstrap = gw.bootstrap.map((b) => b.host + ':' + b.port).join(',')
  const mobile = await start('node', [path.join(here, 'mobile.mjs'), '--bootstrap', bootstrap, '--dir', path.join(tmp, 'mobile')], 'mobile')
  const relay = 'ws://127.0.0.1:' + gw.port + '/p2p'
  console.log('gateway', gw.port, 'mobile', mobile.port)

  browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
  const page = await browser.newPage()
  page.on('console', (m) => process.env.S2_VERBOSE && console.log('[browser]', m.text()))
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto('http://127.0.0.1:' + gw.port + '/index.html')
  results.browser = browser.version()
  const rpc = (cmd, args) => page.evaluate(([c, a]) => window.rpc(c, a), [cmd, args])
  const restartWorker = async (reload) => {
    await page.evaluate(() => window.stopWorker())
    if (reload) await page.reload()
    await page.evaluate(() => window.startWorker())
  }
  await page.evaluate(() => window.startWorker())

  const only = process.argv.includes('--p2p-only')
  if (!only) {
  step('3a storage: Corestore + Autobase on rocksdb-idb, close, reopen (new worker, page reload)')
  const name = 'spike-a-' + Date.now()
  const w = await rpc('storageWrite', { name, blocks: 500, entries: 100 })
  await restartWorker(true)
  const r = await rpc('storageRead', { name, coreKey: w.coreKey, baseKey: w.baseKey, blocks: 500, entries: 100 })
  results.storage = { write: w, read: r }
  console.log(JSON.stringify(results.storage))

  step('3c proof of work: browser vs Node')
  results.pow = { browser: await rpc('pow', {}), node: await nodePow() }
  console.log(JSON.stringify(results.pow))
  }

  step('3b HuwaNode in the browser through the relay <-> mobile HuwaNode')
  const nodeName = 'spike-node-' + Date.now()
  const started = await rpc('nodeStart', { relay, name: nodeName, deviceName: 'navigateur', debug: !!process.env.RELAY_DEBUG })
  const ident = await post(mobile.port, 'identity', { name: 'Mobile S2' })
  const { invite } = await post(mobile.port, 'invite')
  if (process.env.S2_WARMUP) await new Promise((r) => setTimeout(r, Number(process.env.S2_WARMUP)))
  let t = Date.now()
  const accepted = await rpc('accept', { invite })
  const pairingMs = Date.now() - t
  const devices = await post(mobile.port, 'devices')
  // phone -> web: a profile change in the home base
  t = Date.now()
  const waitBio = rpc('waitMe', { field: 'bio', value: 'bio depuis le mobile' })
  await post(mobile.port, 'profile', { bio: 'bio depuis le mobile' })
  await waitBio
  const homePhoneToWebMs = Date.now() - t
  // web -> phone: a comment (room Autobase, PoW included)
  const work = String(900000 + Math.floor(Math.random() * 99999))
  t = Date.now()
  const wc = await rpc('comment', { work, text: 'Commentaire écrit dans le navigateur' })
  const wseen = await post(mobile.port, 'waitComment', { work, id: wc.id })
  const commentWebToPhoneMs = Date.now() - t
  // phone -> web
  t = Date.now()
  // another room: comments are rate limited per author and room, and both devices are the same author
  const work2 = String(Number(work) + 1)
  const mc = await post(mobile.port, 'comment', { work: work2, text: 'Réponse depuis le mobile' })
  await rpc('waitComment', { work: work2, id: mc.id })
  const commentPhoneToWebMs = Date.now() - t
  const me = await rpc('me')
  results.p2p = {
    nodeReadyMs: Math.round(started.readyMs),
    pairing: { ms: pairingMs, sameIdentity: accepted.me.key === ident.profile.key, name: accepted.me.name, devicesOnMobile: devices.length },
    homeBasePhoneToWebMs: homePhoneToWebMs,
    commentWebToPhone: { totalMs: commentWebToPhoneMs, appendWithPowMs: Math.round(wc.ms), propagationMs: wseen.ms },
    commentPhoneToWebMs,
    browserPeers: me.peers
  }
  console.log(JSON.stringify(results.p2p))

  step('3d relay never sees secrets: inbound bytes + heap snapshot + custodial control')
  const secrets = await rpc('secrets')
  results.audit = await audit(gw.port, secrets, relay)
  console.log(JSON.stringify(results.audit))

  step('restart: the browser node comes back from IndexedDB')
  await rpc('nodeClose')
  await restartWorker(true)
  const again = await rpc('nodeStart', { relay, name: nodeName })
  results.restart = { readyMs: Math.round(again.readyMs), identityRestored: !!again.me && again.me.key === ident.profile.key, bio: again.me && again.me.bio }
  console.log(JSON.stringify(results.restart))
  await rpc('nodeClose')

  step('identity created in the browser (phrase, keet-identity-key)')
  results.browserIdentity = await rpc('identityTest', { relay, name: 'spike-ident-' + Date.now() })
  console.log(JSON.stringify(results.browserIdentity))

  await browser.close()
  fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  console.log('\nresults -> spike/results.json')
}

async function nodePow() {
  const sodium = require(path.join(repo, 'node_modules', 'sodium-universal'))
  const pow = require(path.join(repo, 'src', 'p2p', 'worklet', 'pow.js'))
  const { blake2b } = await import(path.join(repo, 'node_modules', '@noble', 'hashes', 'blake2.js'))
  const payload = pow.commentPowPayload('ab'.repeat(32), 'ep:12-e3', 'Un commentaire de taille normale pour le banc.')
  const buf = Buffer.concat([Buffer.from(payload), Buffer.alloc(4)])
  const hash = Buffer.alloc(32)
  const rate = (fn) => {
    let n = 0
    const t0 = performance.now()
    while (performance.now() - t0 < 1500) {
      for (let i = 0; i < 1000; i++) {
        buf[buf.length - 1] = i & 255
        fn()
      }
      n += 1000
    }
    return Math.round(n / ((performance.now() - t0) / 1000))
  }
  const out = { sodiumHashesPerSec: rate(() => sodium.crypto_generichash(hash, buf)), nobleHashesPerSec: rate(() => blake2b(buf, { dkLen: 32 })), solve: {} }
  for (const b of [8, 12, 16]) {
    const times = []
    for (let r = 0; r < 4; r++) {
      const t = performance.now()
      await pow.solve(payload + ' #' + r, b)
      times.push(performance.now() - t)
    }
    out.solve[b] = { avgMs: Math.round(times.reduce((a, x) => a + x, 0) / times.length), maxMs: Math.round(Math.max(...times)) }
  }
  return out
}

/** Looks for every browser secret in what the relay received and in its heap. */
async function audit(port, secrets, relay) {
  // Control: a custodial client (default mode of dht-relay) sends its secret key; the gateway
  // must refuse it, and the byte search below must find that key (the detector works).
  const DHTRelay = require('@hyperswarm/dht-relay')
  const RelayStream = require('@hyperswarm/dht-relay/ws')
  const { WebSocket } = require('ws')
  const control = DHTRelay.keyPair()
  const ws = new WebSocket(relay)
  const closed = new Promise((resolve) => ws.on('close', resolve))
  const custodial = new DHTRelay(new RelayStream(true, ws), { keyPair: control })
  custodial.on?.('error', () => {})
  const refused = await Promise.race([closed.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))])

  const heap = await post(port, '__audit/heap')
  const dump = await post(port, '__audit/dump')
  const inbound = fs.readFileSync(dump.file)
  const heapText = fs.readFileSync(heap.file, 'utf8')
  const forms = (hex) => {
    const b = Buffer.from(hex, 'hex')
    return [hex, b.toString('base64'), b.toString('base64url')]
  }
  const check = (hex) => {
    const b = Buffer.from(hex, 'hex')
    const parts = b.byteLength === 64 ? [b, b.subarray(0, 32)] : [b]
    return {
      inInboundBytes: parts.some((p) => inbound.indexOf(p) !== -1),
      inHeapStrings: forms(hex).some((f) => heapText.includes(f))
    }
  }
  const found = {}
  for (const [k, v] of Object.entries(secrets)) if (v) found[k] = check(v)
  const controlFound = check(Buffer.from(control.secretKey).toString('hex'))
  return {
    inboundBytes: inbound.byteLength,
    heapSnapshotMB: Math.round(heapText.length / 1e6),
    gatewayStats: dump.stats,
    browserSecrets: found,
    leak: Object.values(found).some((f) => f.inInboundBytes || f.inHeapStrings),
    custodialControl: { refused, keyFoundInInbound: controlFound.inInboundBytes }
  }
}

try {
  await main()
} catch (err) {
  console.error(err)
  fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify({ ...results, error: String(err && err.stack) }, null, 2) + '\n')
  process.exitCode = 1
} finally {
  for (const c of children) c.kill('SIGTERM')
  if (browser) await browser.close().catch(() => {})
  if (gwInProc) await gwInProc.close().catch(() => {})
}
