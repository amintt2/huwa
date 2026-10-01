// RPC server: a worklet whose start failed must not answer `hello` as a successful boot.
// Run: npm run test:p2p
import test from 'node:test'
import assert from 'node:assert/strict'
import { Duplex } from 'streamx'
import RPC from 'bare-rpc'
import b4a from 'b4a'
import rpcMod from '../../src/p2p/worklet/rpc.js'

const { serve, CMD } = rpcMod

function pair() {
  let a = null
  let b = null
  a = new Duplex({ write: (data, cb) => (b.push(data), cb()) })
  b = new Duplex({ write: (data, cb) => (a.push(data), cb()) })
  return [a, b]
}

async function call(client, m, a = []) {
  const req = client.request(CMD.CALL)
  req.send(JSON.stringify({ m, a }))
  return JSON.parse(b4a.toString(await req.reply()))
}

test('rpc: a failed start rejects hello and every call; a good start answers', async () => {
  const [w1, a1] = pair()
  const events = []
  serve(w1, () => ({ ready: () => Promise.reject(new Error('corestore verrouillé')), status: () => ({ state: 'error', peers: 0 }), me: () => null }))
  const client = new RPC(a1, (req) => req.command === CMD.EVENT && events.push(JSON.parse(b4a.toString(req.data))))
  const hello = await call(client, 'hello')
  assert.equal(hello.ok, false)
  assert.match(hello.e, /verrouillé/)
  assert.equal((await call(client, 'status')).ok, false)
  assert.equal(events.at(-1)?.data?.state, 'error')

  const [w2, a2] = pair()
  serve(w2, () => ({ ready: async () => {}, status: () => ({ state: 'ready', peers: 0 }), me: () => null }))
  const ok = await call(new RPC(a2, () => {}), 'hello')
  assert.equal(ok.ok, true)
  assert.equal(ok.v.status.state, 'ready')
  for (const s of [w1, a1, w2, a2]) s.destroy()
})
