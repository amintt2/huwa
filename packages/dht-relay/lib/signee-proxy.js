const { nextId } = require('./id')

// HUWA FORK: hyperdht 6.x calls signAnnounce(target, token, peerId, ann, ...) with
// ann = { peer: { publicKey, relayAddresses }, refresh, bump }. Upstream 0.4.3 destructured
// `{ peer: relayAddresses }` (the hyperdht 5 shape), forwarded the whole peer object as the relay
// address list, failed to encode the request and every non-custodial announce hung.
class SigneeProxy {
  constructor (node, protocol, target, signee) {
    this._node = node
    this._protocol = protocol
    this._target = target
    this._signee = signee

    this._signAnnounce = sign.bind(this, 'signAnnounce')
    this._signUnannounce = sign.bind(this, 'signUnannounce')
  }
}

module.exports = {
  SigneeProxy,
  relayAddressesOf
}

function relayAddressesOf (ann) {
  if (!ann || !ann.peer) return []
  // hyperdht >= 6: { peer: { publicKey, relayAddresses } }; hyperdht 5: { peer: [addresses] }
  if (Array.isArray(ann.peer)) return ann.peer
  return ann.peer.relayAddresses || []
}

function sign (kind, target, token, peerId, ann) {
  // A refresh token is part of what hyperdht signs; the browser signs the plain announce, so a
  // refreshing announce cannot be relayed (hyperdht never sets it for a first announce).
  if (ann && ann.refresh) return Promise.reject(new Error('refresh announces cannot be relayed'))
  // The client is gone: nobody will ever sign. Without this the unannounce of its servers waited
  // forever, so they never closed and the key pair stayed "in use" on this DHT node.
  if (this._node._closed || this._protocol._stream.destroyed) return Promise.reject(new Error('Relay client gone'))

  const id = nextId()

  this._protocol[kind].send({
    id,
    signee: this._signee,
    token,
    peerId,
    relayAddresses: relayAddressesOf(ann)
  })

  return new Promise((resolve, reject) => {
    this._node._signatures.set(id, { resolve, reject })
  })
}
