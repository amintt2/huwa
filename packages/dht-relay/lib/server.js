const EventEmitter = require('events')
const SecretStream = require('@hyperswarm/secret-stream')

const { Firewall } = require('./firewall')
const { Signee } = require('./signee')
const { Stream } = require('./stream')

const crypto = require('./crypto')
const { nextId } = require('./id')

class Server extends EventEmitter {
  constructor (node, protocol, alias, options = {}) {
    super()

    this._node = node
    this._protocol = protocol
    this._alias = alias
    this._custodial = options.custodial !== false

    this._firewall = new Firewall(node, protocol, options.firewall || allowAll)

    this._remoteAlias = null
    this._keyPair = null
    this._address = null
    this._listening = null
    this._closing = null
    this._closed = false

    this._onStreamClose = onStreamClose.bind(this)

    this._protocol._stream
      .once('close', this._onStreamClose)

    this._onClosed = onClosed.bind(this)
    this._onListening = onListening.bind(this)
    this._onConnection = onConnection.bind(this)
    this._onListenError = onListenError.bind(this)

    this.ready = async function ready () {
      await this._protocol.ready()
    }
  }

  get closed () {
    return this._closing !== null
  }

  get publicKey () {
    return this._keyPair && this._keyPair.publicKey
  }

  listen (keyPair = this._node.defaultKeyPair) {
    if (this._listening) return this._listening

    this._keyPair = keyPair

    this._node._signees.set(
      this._alias,
      new Signee(this._protocol, crypto.hash(keyPair.publicKey), keyPair)
    )

    this._protocol.listen.send({
      custodial: this._custodial,
      alias: this._alias,
      publicKey: keyPair.publicKey,
      secretKey: keyPair.secretKey
    })

    // HUWA FORK: rejects when the relay reports it could not listen (listenError).
    this._listening = new Promise((resolve, reject) => {
      this.once('listening', () => resolve())
      this.once('listen-error', reject)
    })

    return this._listening
  }

  address () {
    return this._address
  }

  // HUWA FORK: Hyperswarm 4 suspends its server; the relay keeps announcing it meanwhile.
  async suspend () {}

  async resume () {}

  async close () {
    if (this._closing) return this._closing

    if (this._listening) {
      try {
        await this._listening
      } catch {
        // never listened (listenError): nothing to close on the relay
        this._closing = Promise.resolve()
        if (!this._closed) this._onClosed()
        return this._closing
      }
    } else {
      this._closing = Promise.resolve()
      return this._closing
    }

    this._protocol.close.send({ alias: this._alias })

    this._closing = new Promise((resolve) => {
      this.once('close', () => resolve())
    })

    return this._closing
  }
}

module.exports = {
  Server
}

function onStreamClose () {
  if (!this._closed) this._onClosed()
}

function onClosed () {
  this._closed = true
  this._closing = Promise.resolve()

  this.emit('close')
}

function onListenError (message) {
  const err = new Error('Relay could not listen: ' + message.error)
  err.code = message.error
  this.emit('listen-error', err)
}

function onListening (message) {
  this._remoteAlias = message.alias

  this._address = {
    publicKey: this.publicKey,
    host: message.host,
    port: message.port
  }

  this.emit('listening')
}

function onConnection (message) {
  const remoteAlias = message.alias
  const alias = nextId()

  const stream = new Stream(
    this._node,
    this._protocol,
    alias,
    remoteAlias,
    false,
    {
      publicKey: this.publicKey
    },
    message.remotePublicKey,
    message.handshakeHash
  )

  this._node._connections.set(remoteAlias, stream)

  const onClose = () => {
    this._node._connections.delete(remoteAlias)
  }

  stream
    .once('close', onClose)

  this._protocol.connected.send({ alias, remoteAlias })

  if (!this._custodial) {
    const handshake = this._node._handshakes.get(message.handshakeId)

    this._node._handshakes.delete(message.handshakeId)

    const encryptedStream = new SecretStream(false, stream, {
      publicKey: stream.publicKey,
      remotePublicKey: stream.remotePublicKey,
      handshake: {
        publicKey: stream.publicKey,
        remotePublicKey: stream.remotePublicKey,
        hash: handshake.hash,
        tx: handshake.tx,
        rx: handshake.rx
      }
    })

    stream.noiseStream = encryptedStream
  }

  this.emit('connection', stream.noiseStream)
}

function allowAll () {
  return false
}
