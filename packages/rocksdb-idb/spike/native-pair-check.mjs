// Control for the browser run: the same pairing + home-base sync between two NATIVE HuwaNodes in
// separate processes, on the gateway's local testnet (no relay involved).
//   node spike/native-pair-check.mjs
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..', '..', '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huwa-s2c-'))
const children = []
function start(args) {
  const child = spawn('node', args, { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(child)
  return new Promise((resolve) => {
    readline.createInterface({ input: child.stdout }).on('line', (l) => l.startsWith('{"ready"') && resolve(JSON.parse(l)))
  })
}
async function post(port, route, body = {}) {
  const json = await (await fetch('http://127.0.0.1:' + port + '/' + route, { method: 'POST', body: JSON.stringify(body) })).json()
  if (json.ok === false) throw new Error(route + ': ' + json.e)
  return json.v
}
try {
  const gw = await start([path.join(repo, 'services', 'huwa-gateway', 'relay.js'), '--port', '0', '--testnet', '3'])
  const bootstrap = gw.bootstrap.map((b) => b.host + ':' + b.port).join(',')
  const a = await start([path.join(here, 'mobile.mjs'), '--bootstrap', bootstrap, '--dir', path.join(tmp, 'a')])
  const b = await start([path.join(here, 'mobile.mjs'), '--bootstrap', bootstrap, '--dir', path.join(tmp, 'b')])
  await post(a.port, 'identity', { name: 'A' })
  const { invite } = await post(a.port, 'invite')
  const acc = await post(b.port, 'accept', { invite })
  const wait = post(b.port, 'waitMe', { field: 'bio', value: 'x' })
  await post(a.port, 'profile', { bio: 'x' })
  const w = await wait
  console.log(JSON.stringify({ pairingMs: acc.ms, homeMs: w.ms }))
} catch (err) {
  console.log('FAILED', err.message)
  process.exitCode = 1
} finally {
  for (const c of children) c.kill('SIGTERM')
}
