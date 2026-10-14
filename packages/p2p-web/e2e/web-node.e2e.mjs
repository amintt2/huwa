// Huwa Web, end to end in a real browser (Playwright): the browser node bundle in a SharedWorker,
// the gateway in its own process on a local HyperDHT testnet, the "phone" = the mobile code path
// in Node (HuwaNode + src/p2p/link-web.ts, what src/app/settings/link-web.tsx runs).
//   cd packages/p2p-web && npm run e2e            (E2E_BROWSERS=chromium,webkit,firefox)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import * as pw from 'playwright'
import { buildAll, startGateway, startPhone, evalInSharedWorker } from './harness.mjs'

const require = createRequire(import.meta.url)
const BROWSERS = (process.env.E2E_BROWSERS || 'chromium').split(',').filter(Boolean)
const audit = fs.mkdtempSync(path.join(os.tmpdir(), 'huwa-e2e-audit-'))
const results = {}

let gw
let phone
test.before(async () => {
  results.bundle = await buildAll()
  gw = await startGateway({ testnet: 3, audit })
  const bootstrap = gw.bootstrap.map((b) => ({ host: b.host, port: b.port }))
  phone = await startPhone({ bootstrap })
})
test.after(async () => {
  await phone?.close()
  await gw?.stop()
  fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'results.json'), JSON.stringify(results, null, 2) + '\n')
})

for (const name of BROWSERS) {
  test(name + ': QR link, comments both ways, two tabs, phrase never stored, gateway audit, logout', async (t) => {
    let browser
    try {
      browser = await pw[name].launch()
    } catch (err) {
      t.skip(name + ' not installed: ' + err.message.split('\n')[0])
      return
    }
    const r = (results[name] = { version: browser.version() })
    const context = await browser.newContext()
    const page = await context.newPage()
    page.on('pageerror', (e) => console.log('[pageerror]', e.message))
    if (process.env.E2E_VERBOSE) page.on('console', (m) => console.log('[page]', m.text()))
    await page.goto(gw.base + '/index.html')
    await page.waitForFunction(() => document.title === 'huwa-e2e-ready')
    const h = (fn, ...args) => page.evaluate(([f, a]) => window.huwa[f](...a), [fn, args])

    // Logged out: the node does not run.
    const first = await h('ready')
    assert.equal(first.state, 'idle')

    // 1. QR link: web shows the QR, the phone scans it (mobile code path), web pairs.
    const url = await h('startLink', 'device')
    assert.match(url, /^huwa:\/\/link-web\?k=/)
    const t0 = Date.now()
    const answered = await phone.answerQr(url)
    const linked = await page.evaluate(() => window.huwa.linkDone())
    r.qrLink = { totalMs: Date.now() - t0, phoneMs: answered.ms, inviteSeenMs: Math.round(linked.inviteMs), pairingMs: Math.round(linked.pairingMs) }
    console.log(name, 'QR link', JSON.stringify(r.qrLink))
    assert.equal(linked.me.key, phone.ident.profile.key)
    assert.ok((await phone.node.devices()).some((d) => d.name === answered.req.name), 'the phone lists the browser')

    // 2. Comments both ways.
    const work = String(700000 + Math.floor(Math.random() * 99999))
    let t1 = Date.now()
    const wc = await h('comment', work, 'Écrit dans le navigateur')
    await phone.waitComment(work, wc.id)
    r.commentWebToPhoneMs = Date.now() - t1
    const work2 = String(Number(work) + 1)
    await h('watch', work2)
    t1 = Date.now()
    const pc = await phone.node.postComment({ target: 'ep:' + work2 + '-e1', text: 'Écrit sur le téléphone', spoiler: false })
    await h('waitComment', work2, pc.id)
    r.commentPhoneToWebMs = Date.now() - t1
    console.log(name, 'comments', r.commentWebToPhoneMs, r.commentPhoneToWebMs)

    // 3. Two tabs share one node.
    const page2 = await context.newPage()
    await page2.goto(gw.base + '/index.html')
    await page2.waitForFunction(() => document.title === 'huwa-e2e-ready')
    const second = await page2.evaluate(() => window.huwa.hello())
    assert.equal(second.me.key, linked.me.key, 'second tab sees the account')
    if (name === 'chromium') {
      const nodes = await evalInSharedWorker(browser, 'self.__huwa.host.ports.size')
      assert.equal(nodes, 2, 'one SharedWorker serves both tabs')
      const locks = await page.evaluate(async () => (await navigator.locks.query()).held.map((l) => l.name))
      assert.equal(locks.filter((n) => n === 'rocksdb-idb:huwa-p2p').length, 1, 'one writer on the storage')
    }
    const wc2 = await page2.evaluate((w) => window.huwa.comment(w, 'Depuis le deuxième onglet'), String(Number(work) + 2))
    await phone.waitComment(String(Number(work) + 2), wc2.id)
    await page2.close()

    // 4. Gateway audit: the browser's secrets are not in what the gateway received, nor in its heap.
    if (name === 'chromium') {
      const secrets = await evalInSharedWorker(browser, `(() => { const n = self.__huwa.session.node; const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); return { swarm: hex(n.swarm.keyPair.secretKey), device: n.secret.device.secretKey, box: n.secret.boxSeed, primary: hex(n.store.primaryKey), writer: n.home.local.keyPair ? hex(n.home.local.keyPair.secretKey) : null } })()`)
      const heap = await gw.post('/__audit/heap')
      const dump = await gw.post('/__audit/dump')
      const inbound = fs.readFileSync(dump.file)
      const heapText = fs.readFileSync(heap.file, 'utf8')
      const leaks = []
      for (const [k, v] of Object.entries(secrets)) {
        if (!v) continue
        const b = Buffer.from(v, 'hex')
        const parts = b.length === 64 ? [b, b.subarray(0, 32)] : [b]
        if (parts.some((p) => inbound.indexOf(p) !== -1)) leaks.push(k + ' in inbound bytes')
        if ([v, b.toString('base64'), b.toString('base64url')].some((f) => heapText.includes(f))) leaks.push(k + ' in heap')
      }
      r.audit = { inboundBytes: inbound.length, heapMB: Math.round(heapText.length / 1e6), leaks }
      assert.deepEqual(leaks, [])
    }

    // 5. Logout revokes this browser on the phone and wipes everything.
    const deviceKey = await h('deviceKey')
    const out = await h('logout')
    assert.equal(out.revoked, true)
    const t2 = Date.now()
    while (!(await phone.node.devices()).some((d) => d.key === deviceKey && d.revoked)) {
      if (Date.now() - t2 > 20000) throw new Error('the phone did not see the revocation')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    r.logout = { ...out, phoneSawRevocationMs: Date.now() - t2 }
    const after = await h('idbContains', [])
    assert.ok(!after.databases.includes('huwa-p2p') && !after.databases.includes('huwa-keys'), 'wiped: ' + after.databases)

    // 6. Recovery phrase: restored account, the phrase is nowhere in browser storage.
    const other = await startPhone({ bootstrap: gw.bootstrap, name: 'Autre compte' })
    try {
      const words = other.ident.phrase
      const t3 = Date.now()
      const restored = await h('restore', words, 'device')
      r.phraseRestoreMs = Date.now() - t3
      assert.equal(restored.key, other.ident.profile.key)
      const scan = await h('idbContains', [words.join(' '), words.slice(0, 4).join(' '), words.join(',')])
      assert.deepEqual(scan.found, [], 'phrase found in browser storage')
      assert.ok(scan.databases.includes('huwa-p2p'))
      await h('logout')
    } finally {
      await other.close()
    }
    await browser.close()
  })
}

test('custodial dht-relay clients are refused by the gateway', async () => {
  const RelayNode = require('@huwa/dht-relay')
  const Stream = require('@huwa/dht-relay/ws')
  const { WebSocket } = require('ws')
  const before = (await gw.health()).stats.custodialRefused
  const ws = new WebSocket(gw.ws)
  ws.on('error', () => {})
  const closed = new Promise((resolve) => ws.on('close', resolve))
  const node = new RelayNode(new Stream(true, ws), { custodial: true })
  node.on('error', () => {})
  await closed
  assert.equal((await gw.health()).stats.custodialRefused, before + 1)
})
