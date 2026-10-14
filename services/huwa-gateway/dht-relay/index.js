const { Protocol } = require('./lib/protocol')
const { Node } = require('./lib/node')
const { NodeProxy, DEFAULT_LIMITS } = require('./lib/node-proxy')

module.exports = Node

// Messages that carry a key pair (custodial when their secret key is set).
const KEYED = new Set(['handshake', 'connect', 'listen', 'announce', 'unannounce'])

/**
 * Serves one relay client on `stream`.
 *
 * HUWA FORK: non-custodial only unless `allowCustodial` is set. A client that sends a secret key
 * (handshake, connect, listen, announce, unannounce) is refused before any handler sees the
 * message: the key bytes are zeroed and the stream destroyed.
 *
 * @param {import('hyperdht')} dht
 * @param {import('streamx').Duplex} stream  framed stream (./ws or ./tcp)
 * @param {object} [options]
 * @param {boolean} [options.allowCustodial=false]
 * @param {object} [options.limits]  see DEFAULT_LIMITS
 * @param {(what: string) => void} [options.onrefuse]  custodial message refused ('custodial:<msg>')
 * @param {(what: string) => void} [options.onlimit]  a limit was hit ('connections', 'queries', ...)
 * @returns {Promise<NodeProxy>} resolves at the client's handshake
 */
module.exports.relay = function relay (dht, stream, options = {}) {
  const { allowCustodial = false, onrefuse = noop } = options

  const guard = allowCustodial
    ? null
    : (name, message) => {
        if (!KEYED.has(name) || !message || !(message.custodial || message.secretKey)) return true
        if (message.secretKey && typeof message.secretKey.fill === 'function') message.secretKey.fill(0)
        onrefuse('custodial:' + name)
        stream.destroy(new Error('Custodial ' + name + ' refused'))
        return false
      }

  const protocol = new Protocol(stream, { guard })

  return new Promise((resolve, reject) => {
    const onClose = () => reject(new Error('Relay client closed before its handshake'))
    stream.once('close', onClose)

    const onHandshake = (message) => {
      stream.off('close', onClose)
      const node = new NodeProxy(dht, protocol, {
        publicKey: message.publicKey,
        secretKey: message.secretKey
      }, options)

      resolve(node)
    }

    protocol
      .once('handshake', onHandshake)
      .heartbeat()
  })
}

module.exports.DEFAULT_LIMITS = DEFAULT_LIMITS

function noop () {}
