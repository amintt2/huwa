// Transport-agnostic RPC dispatcher of a HuwaNode: `{m, a}` -> value, `watch` subscriptions pushed
// through `sendEvent({ ev: 'sub', sid, data })`. Used by the Bare worklet (rpc.js, over bare-rpc)
// and by the browser node (src/p2p/web/host.js, over MessagePorts).

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
  'listFlags',
  'flagComment',
  'vouch',
  'listComments',
  'listMapping',
  'proposeMapping',
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
  'journal',
  'contributeStats',
  'communityStats',
  'setRelays',
  'relayStatus'
])

/**
 * @param {object} node  HuwaNode (or anything with ready/status/me/watch and the METHODS)
 * @param {(ev: object) => void} sendEvent
 * @param {{ log?: Function, started?: number, extra?: (m: string, a: unknown[]) => unknown, ready?: Promise<void> }} [opts]
 *   `extra` answers methods that are not node methods (return undefined to fall through);
 *   `ready` is the node's start when the caller already started it (HuwaNode.ready() is not
 *   idempotent: it must run once).
 */
function createDispatcher(node, sendEvent, { log = () => {}, started = Date.now(), extra = null, ready: started_ = null } = {}) {
  // A failed start stays a rejection: `hello` (and every call) fails with it, so the app side
  // does not count the boot as successful and SwitchingP2P falls back to the local backend.
  const ready = (started_ || node.ready()).then(
    () => log('ready in', Date.now() - started, 'ms'),
    (err) => {
      node.state = 'error'
      log('ready failed', err && err.stack)
      sendEvent({ ev: 'status', data: { state: 'error', peers: 0, error: String(err && err.message) } })
      throw err
    }
  )
  ready.catch(() => {})
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
    if (extra) {
      const v = await extra(m, Array.isArray(a) ? a : [])
      if (v !== undefined) return v
    }
    if (!METHODS.has(m)) throw new Error('Méthode inconnue: ' + m)
    return node[m](...(Array.isArray(a) ? a : []))
  }

  /** `{m, a}` -> `{ok, v}` | `{ok: false, e, code?}` (the wire reply). */
  async function reply(m, a) {
    try {
      const v = await call(m, a)
      return { ok: true, v: v === undefined ? null : v }
    } catch (err) {
      const out = { ok: false, e: (err && err.message) || String(err) }
      if (err && typeof err.code === 'string') out.code = err.code
      return out
    }
  }

  function stopAll() {
    for (const stop of watches.values()) stop()
    watches.clear()
  }

  return { call, reply, ready, watches, stopAll }
}

module.exports = { createDispatcher, METHODS }
