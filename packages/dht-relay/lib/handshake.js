const buffer = require('b4a')
const NoiseHandshake = require('noise-handshake')
const SecretStream = require('@hyperswarm/secret-stream')
const { NS } = require('hyperdht/lib/constants')
const curve = require('noise-curve-ed')
const sodium = require('sodium-universal')
const { decode } = require('compact-encoding')
const { noisePayload } = require('hyperdht/lib/messages')
const safetyCatch = require('safety-catch')

const NOISE_PROLOUGE = NS.PEER_HANDSHAKE

class Handshake {
  constructor (node, protocol, firewall, id, isInitiator, keyPair, remotePublicKey) {
    this._node = node
    this._protocol = protocol
    this._firewall = firewall
    this._id = id

    this.isInitiator = isInitiator
    this.keyPair = keyPair
    this.remotePublicKey = remotePublicKey
    this.remoteId = null
    this.holepunchSecret = null
    this.complete = false

    this._handshake = new NoiseHandshake('IK', isInitiator, keyPair, { curve })
    this._handshake.initialise(NOISE_PROLOUGE, remotePublicKey)

    this._onComplete = onComplete.bind(this)
    this._onNoise = onNoise.bind(this)
    this._onNoiseSend = onNoiseSend.bind(this)
    this._onNoiseReceive = onNoiseReceive.bind(this)
  }

  get hash () {
    return this._handshake.hash
  }

  get tx () {
    return this._handshake.tx
  }

  get rx () {
    return this._handshake.rx
  }
}

module.exports = {
  Handshake
}

function onComplete () {
  this.complete = true

  const hash = this._handshake.hash

  this.remoteId = SecretStream.id(hash, true)
  this.holepunchSecret = buffer.allocUnsafe(32)

  sodium.crypto_generichash(this.holepunchSecret, NS.PEER_HOLEPUNCH, hash)
}

function onNoise (payload) {
  if (this._handshake.complete) {
    this._onComplete()
  } else {
    this.remotePublicKey = this._handshake.rs

    if (this._firewall) {
      const remoteHandshakePayload = decode(noisePayload, payload)

      let deny = true
      try {
        deny = this._firewall._deny(this.remotePublicKey, remoteHandshakePayload)
      } catch (err) {
        safetyCatch(err)
      }

      if (deny) {
        this._node._handshakes.delete(this._id)

        return this._protocol.noiseReply.send({
          id: this._id,
          payload: null,
          remotePublicKey: this.remotePublicKey
        })
      }
    }
  }

  this._protocol.noiseReply.send({
    id: this._id,
    payload,
    isInitiator: this.isInitiator,
    complete: this.complete,
    remoteId: this.remoteId,
    holepunchSecret: this.holepunchSecret,
    remotePublicKey: this.remotePublicKey || buffer.alloc(32)
  })
}

// HUWA FORK: hyperdht's connect runs the Noise exchange through several DHT nodes in parallel and
// can hand the same server reply to `recv` twice. Upstream threw on the second one (the handshake
// was complete); the exception escaped into the relay transport and froze the whole relay stream:
// every connection, announce and signature request of that browser died ("connection timed out"
// on the relay's side). Answer with a denial instead: the relay rejects that duplicate only.
function onNoiseSend (message) {
  let payload
  try {
    payload = this._handshake.send(message.payload)
  } catch {
    return deny.call(this)
  }
  this._onNoise(payload)
}

function onNoiseReceive (message) {
  let payload
  try {
    payload = this._handshake.recv(message.payload)
  } catch {
    return deny.call(this)
  }
  this._onNoise(payload)
}

function deny () {
  this._protocol.noiseReply.send({
    id: this._id,
    payload: null,
    remotePublicKey: this.remotePublicKey || buffer.alloc(32)
  })
}
