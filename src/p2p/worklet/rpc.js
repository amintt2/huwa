// RPC server shared by the Bare entry point and the Node test harness.
// Wire protocol (bare-rpc over the worklet IPC):
//   CALL  (1) RN -> worklet  request  {m, a}           reply {ok: true, v} | {ok: false, e}
//   EVENT (2) worklet -> RN  event    {ev, sid?, data}
const RPC = require('bare-rpc')
const b4a = require('b4a')

const { createDispatcher, METHODS } = require('./dispatch')

const CMD = { CALL: 1, EVENT: 2 }

function serve(stream, createNode, { log = () => {} } = {}) {
  let rpc = null
  const sendEvent = (ev) => {
    if (!rpc) return
    try {
      rpc.event(CMD.EVENT).send(JSON.stringify(ev))
    } catch (err) {
      log('event send failed', err && err.message)
    }
  }
  const node = createNode(sendEvent)
  const dispatcher = createDispatcher(node, sendEvent, {
    log,
    extra: (m) => {
      if (m === 'selftest') return selftest(node)
      if (m === 'crash') {
        // Deliberate failure to check that the uncaught handlers keep the app alive.
        setTimeout(() => {
          throw new Error('crash volontaire (test)')
        }, 0)
        Promise.reject(new Error('rejet volontaire (test)'))
        return 'scheduled'
      }
      return undefined
    }
  })

  rpc = new RPC(stream, async (req) => {
    if (req.command !== CMD.CALL) return
    let reply
    try {
      const { m, a } = JSON.parse(b4a.toString(req.data))
      reply = await dispatcher.reply(m, a)
    } catch (err) {
      reply = { ok: false, e: (err && err.message) || String(err) }
    }
    try {
      req.reply(JSON.stringify(reply))
    } catch (err) {
      log('reply failed', err && err.message)
    }
  })

  return { rpc, node, sendEvent }
}

/** Spike criterion: Hyperbee put/get through RPC. */
async function selftest(node) {
  const Hyperbee = require('hyperbee')
  const bee = new Hyperbee(node.store.get({ name: 'selftest' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.ready()
  const t = Date.now()
  await bee.put('k', { t })
  const got = await bee.get('k')
  await bee.close()
  return { put: t, get: got && got.value, ok: !!got && got.value.t === t, length: bee.core ? bee.core.length : null }
}

module.exports = { serve, CMD, METHODS }
