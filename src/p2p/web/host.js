// RPC host of the browser node: serves any number of tabs (MessagePorts of a SharedWorker, or
// the leader's channel in the fallback) with the same {m, a} protocol as the mobile worklet.
//
//   tab -> host  { t: 'call', id, m, a }
//   host -> tab  { t: 'reply', id, ok, v | e, code? }   (src/p2p/rpc-p2p.ts RpcReply)
//                { t: 'event', ev, sid?, data }           (RpcEvent; `sid` is the tab's own)
//
// Node methods go to the dispatcher of the running node (src/p2p/worklet/dispatch.js); `session.*`
// methods drive WebSession (session.js). Watch ids are per tab: the host maps them to global ids.
const { createDispatcher } = require('../worklet/dispatch')

// Status without a node: a logged-out browser is a normal, empty profile; a locked one is offline.
const noNode = (session) => (session.state === 'locked' ? { state: 'offline', peers: 0 } : session.state === 'error' ? { state: 'error', peers: 0, error: session.error && session.error.message } : { state: 'ready', peers: 0 })

function createHost(session, { log = () => {} } = {}) {
  const ports = new Set()
  const subs = new Map() // global sid -> { port, sid, kind, arg }
  let nextSid = 1
  let dispatcher = null
  let node = null

  const post = (port, msg) => {
    try {
      port.postMessage(msg)
    } catch (err) {
      log('post failed', err && err.message)
      ports.delete(port)
    }
  }

  const broadcast = (msg) => {
    for (const p of ports) post(p, msg)
  }

  function onNodeEvent(ev) {
    if (ev.ev === 'sub') {
      const s = subs.get(ev.sid)
      if (s) post(s.port, { t: 'event', ev: 'sub', sid: s.sid, data: ev.data })
      return
    }
    broadcast({ t: 'event', ...ev })
  }

  function attachNode(n) {
    if (dispatcher) dispatcher.stopAll()
    node = n
    // The session started the node already (HuwaNode.ready() must run once).
    dispatcher = n ? createDispatcher(n, onNodeEvent, { log, ready: Promise.resolve() }) : null
    if (!n) return
    // Re-subscribe every tab's watches on the new node.
    for (const [gsid, s] of subs) dispatcher.call('watch', [gsid, s.kind, s.arg]).catch(() => {})
  }

  async function call(port, m, a) {
    if (m.startsWith('session.')) return sessionCall(m.slice(8), a)
    if (m === 'hello') {
      await session.init().catch(() => {})
      if (!dispatcher) return { status: noNode(session), me: null, readyMs: 0, session: session.info() }
      const v = await dispatcher.call('hello', [])
      return { ...v, session: session.info() }
    }
    if (m === 'watch') {
      const [sid, kind, arg] = a
      const gsid = nextSid++
      subs.set(gsid, { port, sid, kind, arg })
      if (dispatcher) await dispatcher.call('watch', [gsid, kind, arg])
      return null
    }
    if (m === 'unwatch') {
      for (const [gsid, s] of subs) {
        if (s.port === port && s.sid === a[0]) {
          subs.delete(gsid)
          if (dispatcher) await dispatcher.call('unwatch', [gsid])
        }
      }
      return null
    }
    if (m === 'status') return dispatcher ? dispatcher.call('status', []) : noNode(session)
    if (m === 'me') return node ? node.me() || null : null
    if (!dispatcher) {
      const err = new Error(session.state === 'locked' ? 'Session verrouillée' : 'Aucune session P2P dans ce navigateur')
      err.code = session.state === 'locked' ? 'LOCKED' : 'NO_SESSION'
      throw err
    }
    return dispatcher.call(m, a)
  }

  async function sessionCall(m, a) {
    switch (m) {
      case 'info':
        await session.init().catch(() => {})
        return session.info()
      case 'begin':
        return session.begin(a[0] || {})
      case 'cancel':
        return session.cancel()
      case 'unlock':
        return session.unlock(a[0])
      case 'lock':
        return session.lock()
      case 'enablePasskey':
        return session.enablePasskey(a[0], a[1] || {})
      case 'disablePasskey':
        return session.disablePasskey(a[0])
      case 'logout':
        return session.logout(a[0] || {})
      case 'deviceKey':
        return node && node.secret ? node.secret.device.publicKey : null
      default:
        throw new Error('Méthode inconnue: session.' + m)
    }
  }

  function connect(port) {
    ports.add(port)
    port.onmessage = async (e) => {
      const msg = e.data
      if (!msg || typeof msg !== 'object') return
      if (msg.t === 'bye') {
        disconnect(port)
        return
      }
      if (msg.t !== 'call') return
      let reply
      try {
        const v = await call(port, String(msg.m), Array.isArray(msg.a) ? msg.a : [])
        reply = { t: 'reply', id: msg.id, ok: true, v: v === undefined ? null : v }
      } catch (err) {
        reply = { t: 'reply', id: msg.id, ok: false, e: (err && err.message) || String(err) }
        if (err && typeof err.code === 'string') reply.code = err.code
      }
      post(port, reply)
    }
    if (typeof port.start === 'function') port.start()
  }

  function disconnect(port) {
    ports.delete(port)
    for (const [gsid, s] of subs) {
      if (s.port !== port) continue
      subs.delete(gsid)
      if (dispatcher) dispatcher.call('unwatch', [gsid]).catch(() => {})
    }
  }

  return { connect, disconnect, attachNode, onNodeEvent, broadcast, ports, subs }
}

module.exports = { createHost }
