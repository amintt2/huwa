// E2E harness: builds the worker (public/p2p-worker.js recipe) and the test page into e2e/dist,
// starts the gateway (services/huwa-gateway, own process, local HyperDHT testnet or the public
// network) serving them, and gives a "phone": the mobile code path (HuwaNode + link-web) in Node.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import readline from 'node:readline'
import { build } from 'esbuild'
import { bundle } from '../build.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..', '..', '..')
const require = createRequire(import.meta.url)
export const dist = path.join(here, 'dist')

export async function buildAll() {
  fs.mkdirSync(dist, { recursive: true })
  const worker = await bundle({ outfile: path.join(dist, 'p2p-worker.js') })
  await build({
    entryPoints: [path.join(here, 'page.ts')],
    bundle: true,
    outfile: path.join(dist, 'page.js'),
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'warning',
    define: { 'process.env.EXPO_PUBLIC_HUWA_GATEWAY': 'undefined' },
    alias: {
      '@react-native-async-storage/async-storage': path.join(here, 'async-storage.js'),
      '@': path.join(repo, 'src')
    },
    nodePaths: [path.join(repo, 'node_modules')]
  })
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>huwa-e2e</title></head><body><script src="page.js"></script></body></html>')
  return worker.sizes
}

/** Gateway in its own process. `testnet: 0` = public HyperDHT. */
export async function startGateway({ testnet = 3, audit = null, env = {} } = {}) {
  const args = ['--expose-gc', path.join(repo, 'services', 'huwa-gateway', 'index.js'), '--port', '0', '--static', dist]
  if (testnet) args.push('--testnet', String(testnet))
  else args.push('--dht-port', '0')
  if (audit) args.push('--audit', audit)
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HUWA_LOG: 'warn', HUWA_WS_PER_IP: '64', ...env } })
  child.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write('[gateway] ' + d))
  const ready = await new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (line.startsWith('{"ready"')) resolve(JSON.parse(line))
      else if (process.env.E2E_VERBOSE) console.log('[gateway]', line)
    })
    child.once('exit', (code) => reject(new Error('gateway exited ' + code)))
  })
  const base = 'http://127.0.0.1:' + ready.port
  return {
    ...ready,
    base,
    ws: 'ws://127.0.0.1:' + ready.port + '/p2p',
    bootstrap: ready.bootstrap,
    async post(route) {
      const res = await fetch(base + route, { method: 'POST' })
      return res.json()
    },
    async health() {
      return (await fetch(base + '/p2p/health')).json()
    },
    stop() {
      child.kill('SIGTERM')
      return new Promise((resolve) => child.once('exit', resolve))
    }
  }
}

const nodeAead = {
  async seal(key, nonce, plaintext, aad) {
    const c = crypto.createCipheriv('aes-256-gcm', key, nonce)
    c.setAAD(aad)
    return new Uint8Array(Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]))
  },
  async open() {
    throw new Error('unused')
  }
}

/** The phone: HuwaNode on native storage + the mobile link-web code path (src/p2p/link-web.ts). */
export async function startPhone({ bootstrap, name = 'Mobile E2E', dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huwa-e2e-phone-')), log } = {}) {
  const { HuwaNode } = require(path.join(repo, 'src', 'p2p', 'worklet', 'node.js'))
  const linkWeb = await import(path.join(repo, 'src', 'p2p', 'link-web.ts'))
  const node = new HuwaNode({ storage: dir, bootstrap, deviceName: 'iPhone E2E', log })
  await node.ready()
  const ident = name ? await node.createIdentity(name) : null
  return {
    node,
    ident,
    /** What src/app/settings/link-web.tsx does after "Lier …": invite, seal, post. */
    async answerQr(url) {
      const req = linkWeb.parseLinkUrl(url)
      const t0 = Date.now()
      const invite = await node.pairingInvite()
      const frame = await linkWeb.sealLinkFrame({ invite, name: 'iPhone E2E', ts: Date.now() }, req, { aead: nodeAead, random: (n) => new Uint8Array(crypto.randomBytes(n)) })
      await linkWeb.postLinkFrame(req, frame)
      return { req, ms: Date.now() - t0 }
    },
    async waitComment(work, id, ms = 30000) {
      const t = Date.now()
      while (Date.now() - t < ms) {
        if ((await node.listComments(work)).some((c) => c.id === id)) return Date.now() - t
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error('phone: timeout waiting for comment ' + id)
    },
    async close() {
      await node.close().catch(() => {})
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Evaluates `expr` in the browser node's SharedWorker (CDP; the worker runs with ?debug=1). */
export async function evalInSharedWorker(browser, expr) {
  const cdp = await browser.newBrowserCDPSession()
  const { targetInfos } = await cdp.send('Target.getTargets')
  const target = targetInfos.find((t) => t.type === 'shared_worker' && t.url.includes('p2p-worker.js'))
  if (!target) throw new Error('no shared worker target')
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })
  const m = await new Promise((resolve) => {
    const on = (e) => {
      if (e.sessionId !== sessionId) return
      const msg = JSON.parse(e.message)
      if (msg.id !== 1) return
      cdp.off('Target.receivedMessageFromTarget', on)
      resolve(msg)
    }
    cdp.on('Target.receivedMessageFromTarget', on)
    cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }) })
  })
  await cdp.detach().catch(() => {})
  if (m.error || m.result.exceptionDetails) throw new Error('worker eval failed: ' + JSON.stringify(m.error || m.result.exceptionDetails))
  return m.result.result.value
}
