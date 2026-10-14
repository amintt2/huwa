// Hyperswarm for browsers: HyperDHT through the Huwa gateway (services/huwa-gateway), with
// @hyperswarm/dht-relay in NON-CUSTODIAL mode. Every key pair is made and kept here: the gateway
// gets public keys, signatures and ciphertext only.
//
// dht-relay 0.4.3 predates parts of the HyperDHT API that Hyperswarm 4 / blind-pairing call:
//   suspend / resume / online / lookupAndUnannounce   -> small local stand-ins
//   mutablePut / mutableGet (blind-pairing requests)  -> signed HERE, stored by the gateway
//                                                        (POST/GET /p2p/mutable, it verifies)
// To move to src/p2p/web/ in phase 3 (spike code for now).
const Hyperswarm = require('hyperswarm')
const DHTRelay = require('@hyperswarm/dht-relay')
const RelayStream = require('@hyperswarm/dht-relay/ws')
const sodium = require('sodium-universal')
const c = require('compact-encoding')
const b4a = require('b4a')
const m = require('hyperdht/lib/messages')
const { NS } = require('hyperdht/lib/constants')

const hex = (b) => b4a.toString(b, 'hex')

function mutableSignable(seq, value) {
  const signable = b4a.allocUnsafe(64)
  signable.set(NS.MUTABLE_PUT, 0)
  sodium.crypto_generichash(signable.subarray(32), c.encode(m.mutableSignable, { seq, value }))
  return signable
}

/**
 * @param {object} o
 * @param {string} o.url   gateway WebSocket, e.g. wss://host/p2p
 * @param {typeof WebSocket} [o.WebSocket]
 * @param {typeof fetch} [o.fetch]
 * @returns {(opts: { keyPair? }) => Hyperswarm}  a HuwaNode `swarmFactory`
 */
function createRelaySwarmFactory({ url, WebSocket = globalThis.WebSocket, fetch = globalThis.fetch.bind(globalThis), sockets = [] }) {
  const http = url.replace(/^ws/, 'http').replace(/\/p2p\/?$/, '/p2p/mutable')

  return function swarmFactory(opts = {}) {
    const ws = new WebSocket(url)
    sockets.push(ws)
    const keyPair = opts.keyPair || DHTRelay.keyPair()
    const dht = new DHTRelay(new RelayStream(true, ws), { custodial: false, keyPair })

    if (!dht.suspend) dht.suspend = async () => {}
    if (!dht.resume) dht.resume = async () => {}
    if (dht.online === undefined) dht.online = true
    if (!dht.lookupAndUnannounce) {
      dht.lookupAndUnannounce = (topic, kp, o) => {
        dht.unannounce(topic, kp).catch(() => {})
        return dht.lookup(topic, o)
      }
    }

    dht.mutablePut = async (kp, value, o = {}) => {
      const seq = o.seq || 0
      const signature = b4a.allocUnsafe(64)
      sodium.crypto_sign_detached(signature, mutableSignable(seq, value), kp.secretKey)
      const res = await fetch(http, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey: hex(kp.publicKey), seq, value: hex(value), signature: hex(signature) })
      })
      if (!res.ok) throw new Error('mutablePut failed: ' + res.status)
      return { publicKey: kp.publicKey, seq, signature }
    }

    dht.mutableGet = async (publicKey, o = {}) => {
      const q = '?seq=' + (o.seq || 0) + '&latest=' + (o.latest === false ? 0 : 1)
      const res = await fetch(http + '/' + hex(publicKey) + q)
      if (!res.ok) throw new Error('mutableGet failed: ' + res.status)
      const r = await res.json()
      if (!r) return null
      const value = b4a.from(r.value, 'hex')
      const signature = b4a.from(r.signature, 'hex')
      // Never trust the gateway: the record must be signed by the key we asked for.
      if (!sodium.crypto_sign_verify_detached(signature, mutableSignable(r.seq, value), publicKey)) return null
      return { seq: r.seq, value, signature }
    }

    // A relay Query only closes once read to the end; hyperdht's `query.finished()` does not need
    // a reader. blind-pairing awaits `dht.announce(...).finished()` without reading: it hung forever.
    for (const name of ['announce', 'lookup']) {
      const fn = dht[name].bind(dht)
      dht[name] = (...args) => {
        const q = fn(...args)
        const finished = q.finished
        q.finished = () => {
          q.resume()
          return finished.call(q)
        }
        return q
      }
    }

    if (globalThis.process && process.env && process.env.RELAY_DEBUG) {
      for (const name of ['mutablePut', 'mutableGet', 'announce', 'unannounce', 'lookup']) {
        const fn = dht[name].bind(dht)
        dht[name] = (...args) => {
          const t = Date.now()
          console.log('[relay-dht]', name, 'start')
          const r = fn(...args)
          if (r && typeof r.then === 'function') r.then((v) => console.log('[relay-dht]', name, 'done', Date.now() - t, 'ms', v === null ? 'null' : ''), (e) => console.log('[relay-dht]', name, 'error', e.message))
          else if (r && typeof r.finished === 'function') r.finished().then(() => console.log('[relay-dht]', name, 'finished', Date.now() - t, 'ms'), (e) => console.log('[relay-dht]', name, 'query error', e.message))
          return r
        }
      }
    }
    const swarm = new Hyperswarm({ keyPair, dht })
    // blind-pairing picks the peer to send a pairing request to by `conn.rawStream.rtt`; the relay
    // stream has none, so no request was ever sent over an open connection (registered first, so
    // it runs before the node's own listeners).
    swarm.on('connection', (conn) => {
      if (conn.rawStream && typeof conn.rawStream.rtt !== 'number') conn.rawStream.rtt = 0
      if (globalThis.process && process.env && process.env.RELAY_DEBUG) {
        let rin = 0
        let rout = 0
        let din = 0
        conn.rawStream.on('data', (d) => (rin += d.byteLength))
        const w = conn.rawStream.write.bind(conn.rawStream)
        conn.rawStream.write = (d) => ((rout += d.byteLength), w(d))
        conn.on('data', (d) => (din += d.byteLength))
        conn.on('open', () => console.log('[relay-conn] open'))
        conn.on('close', () => console.log('[relay-conn] close raw in', rin, 'raw out', rout, 'decrypted in', din))
      }
    })
    return swarm
  }
}

module.exports = { createRelaySwarmFactory }
