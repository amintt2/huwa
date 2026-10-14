// Reliability bench of "Lier avec mon téléphone" (QR link) on a REAL network: the public
// HyperDHT bootstrap, the gateway in its own process (services/huwa-gateway), the "phone" in its
// own process (bench/phone.mjs: native HuwaNode on UDP) and Chromium running the browser node.
// Every run uses a fresh browser profile: QR shown -> phone answers -> web paired, then a comment
// each way, then logout (signed revoke, seen by the phone).
//   node bench/link-bench.mjs [--runs 20] [--testnet] [--browser chromium] [--headed]
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import readline from 'node:readline'
import * as pw from 'playwright'
import { buildAll, startGateway } from '../e2e/harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  return i === -1 ? def : process.argv[i + 1]
}
const RUNS = Number(arg('runs', 20))
const TESTNET = process.argv.includes('--testnet')
const LINK_TIMEOUT = 60_000
const browserName = arg('browser', 'chromium')

function spawnPhone(bootstrap) {
  const args = [path.join(here, 'phone.mjs')]
  if (bootstrap) args.push('--bootstrap', bootstrap)
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.on('data', (d) => process.env.BENCH_VERBOSE && process.stderr.write('[phone] ' + d))
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (line.startsWith('{"ready"')) {
        const info = JSON.parse(line)
        const call = async (route, body = {}) => {
          const res = await fetch('http://127.0.0.1:' + info.port + '/' + route, { method: 'POST', body: JSON.stringify(body) })
          const j = await res.json()
          if (!j.ok) throw new Error(route + ': ' + j.e.split('\n')[0])
          return j.v
        }
        resolve({ ...info, call, stop: () => child.kill('SIGTERM') })
      }
    })
    child.once('exit', (code) => reject(new Error('phone exited ' + code)))
  })
}

const within = (p, ms, what) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout: ' + what)), ms))])
const pct = (xs, p) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

async function main() {
  const out = { date: new Date().toISOString(), network: TESTNET ? 'local testnet' : 'public HyperDHT', runs: [] }
  out.bundle = await buildAll()
  const gw = await startGateway({ testnet: TESTNET ? 3 : 0 })
  const bootstrap = TESTNET ? gw.bootstrap.map((b) => b.host + ':' + b.port).join(',') : ''
  const health = await gw.health()
  out.gateway = { dht: health.dht }
  const phone = await spawnPhone(bootstrap)
  out.phone = await phone.call('me')
  console.log('gateway', JSON.stringify(health.dht), 'phone', JSON.stringify({ firewalled: out.phone.firewalled, host: out.phone.host }))
  const browser = await pw[browserName].launch({ headless: !process.argv.includes('--headed') })
  out.browser = browserName + ' ' + browser.version()

  for (let i = 0; i < RUNS; i++) {
    const run = { i, ok: false }
    const context = await browser.newContext()
    const page = await context.newPage()
    page.on('pageerror', (e) => (run.pageerror = e.message))
    try {
      await page.goto(gw.base + '/index.html')
      await page.waitForFunction(() => document.title === 'huwa-e2e-ready')
      const h = (fn, ...args) => page.evaluate(([f, a]) => window.huwa[f](...a), [fn, args])
      const url = await h('startLink', 'device')
      const t0 = Date.now()
      const answered = await phone.call('answerQr', { url })
      run.phoneMs = answered.ms
      const linked = await within(page.evaluate(() => window.huwa.linkDone()), LINK_TIMEOUT, 'QR link')
      run.linkMs = Date.now() - t0
      run.pairingMs = Math.round(linked.pairingMs)
      // Comments both ways.
      const work = String(500000 + Math.floor(Math.random() * 400000))
      let t = Date.now()
      const wc = await h('comment', work, 'bench ' + i)
      await phone.call('waitComment', { work, id: wc.id, ms: 30000 })
      run.commentWebToPhoneMs = Date.now() - t
      const work2 = String(Number(work) + 1)
      await h('watch', work2)
      t = Date.now()
      const pc = await phone.call('comment', { work: work2, text: 'bench phone ' + i })
      await within(h('waitComment', work2, pc.id, 30000), 35000, 'comment phone -> web')
      run.commentPhoneToWebMs = Date.now() - t
      // Logout: revoke seen by the phone.
      const key = await h('deviceKey')
      t = Date.now()
      const lo = await h('logout')
      run.logout = { revoked: lo.revoked, replicated: lo.replicated, ms: Date.now() - t }
      await phone.call('waitRevoked', { key, ms: 30000 })
      run.revokeSeenMs = Date.now() - t
      run.ok = true
    } catch (err) {
      run.error = err.message
    }
    out.runs.push(run)
    console.log(JSON.stringify(run))
    await context.close().catch(() => {})
  }

  const ok = out.runs.filter((r) => r.ok)
  const links = out.runs.filter((r) => r.linkMs !== undefined).map((r) => r.linkMs)
  out.summary = {
    runs: RUNS,
    fullSuccess: ok.length,
    linked: links.length,
    linkUnder20s: links.filter((ms) => ms < 20000).length,
    linkMs: { min: Math.min(...links), p50: pct(links, 50), p95: pct(links, 95), max: Math.max(...links) },
    commentWebToPhoneMs: { p50: pct(ok.map((r) => r.commentWebToPhoneMs), 50), max: Math.max(...ok.map((r) => r.commentWebToPhoneMs)) },
    commentPhoneToWebMs: { p50: pct(ok.map((r) => r.commentPhoneToWebMs), 50), max: Math.max(...ok.map((r) => r.commentPhoneToWebMs)) },
    gatewayStats: (await gw.health()).stats
  }
  console.log('\nSUMMARY', JSON.stringify(out.summary, null, 2))
  const file = path.join(here, 'results-' + (TESTNET ? 'testnet' : 'public') + '-' + browserName + '.json')
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
  console.log('->', path.relative(process.cwd(), file))
  await browser.close()
  phone.stop()
  await gw.stop()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
