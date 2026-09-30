// RPC server shared by the Bare entry point and the Node test harness.
// Wire protocol (bare-rpc over the worklet IPC):
//   CALL  (1) RN -> worklet  request  {m, a}           reply {ok: true, v} | {ok: false, e}
//   EVENT (2) worklet -> RN  event    {ev, sid?, data}
const RPC = require('bare-rpc')
const b4a = require('b4a')

const CMD = { CALL: 1, EVENT: 2 }

const METHODS = new Set([
  'createIdentity',
  'restoreIdentity',
  'updateProfile',
  'getProfile',
  'backupState',
  'markPhraseVerified',
  'devices',
  'pairingInvite',
  'acceptPairing',
  'revokeDevice',
  'identityLog',
  'postComment',
  'toggleLike',
  'editComment',
  'deleteComment',
  'vouch',
  'listComments',
  'follow',
  'unfollow',
  'block',
  'unblock',
  'report',
  'subscribeLabeler',
  'listLabels',
  'listConversations',
  'listMessages',
  'sendMessage',
  'markRead',
  'appendJournal',
  'journal'
])

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
  const started = Date.now()
  const ready = node.ready().then(
    () => log('ready in', Date.now() - started, 'ms'),
    (err) => {
      node.state = 'error'
      log('ready failed', err && err.stack)
      sendEvent({ ev: 'status', data: { state: 'error', peers: 0, error: String(err && err.message) } })
    }
  )
  const watches = new Map()

  async function call(m, a) {
    if (m === 'hello') {
      await ready
      return { status: node.status(), me: node.me() || null, readyMs: Date.now() - started }
    }
    await ready
    if (m === 'status') return node.status()
    if (m === 'me') return node.me() || null
    if (m === 'watch') {
      const [sid, kind, arg] = a
      if (typeof sid !== 'number' || watches.has(sid)) throw new Error('watch id invalide')
      watches.set(sid, node.watch(kind, arg, (data) => sendEvent({ ev: 'sub', sid, data })))
      return null
    }
    if (m === 'unwatch') {
      const stop = watches.get(a[0])
      watches.delete(a[0])
      if (stop) stop()
      return null
    }
    if (m === 'selftest') return selftest(node)
    if (m === 'crash') {
      // Deliberate failure to check that the uncaught handlers keep the app alive.
      setTimeout(() => {
        throw new Error('crash volontaire (test)')
      }, 0)
      Promise.reject(new Error('rejet volontaire (test)'))
      return 'scheduled'
    }
    if (!METHODS.has(m)) throw new Error('Méthode inconnue: ' + m)
    return node[m](...(Array.isArray(a) ? a : []))
  }

  rpc = new RPC(stream, async (req) => {
    if (req.command !== CMD.CALL) return
    let reply
    try {
      const { m, a } = JSON.parse(b4a.toString(req.data))
      const v = await call(m, a)
      reply = { ok: true, v: v === undefined ? null : v }
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
