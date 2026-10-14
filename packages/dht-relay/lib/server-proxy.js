const { FirewallProxy } = require('./firewall-proxy')
const { HandshakeProxy } = require('./handshake-proxy')
const { SigneeProxy } = require('./signee-proxy')
const { StreamProxy } = require('./stream-proxy')

const crypto = require('./crypto')
const { nextId } = require('./id')

// HUWA FORK: a browser that reconnects re-listens with the same key pair while the server of its
// previous relay connection is still closing on this DHT node (KEYPAIR_ALREADY_USED): retry a few
// times, then report the failure to the client (`listenError`) instead of leaving it waiting for
// a `listening` that never comes (and an unhandled rejection here).
const LISTEN_RETRIES = 6
const LISTEN_RETRY_MS = 500
const debug = typeof process !== 'undefined' && process.env && process.env.HUWA_RELAY_DEBUG ? (...a) => console.log('[relay]', ...a) : () => {}

class ServerProxy {
  constructor (node, protocol, alias, remoteAlias, keyPair) {
    this._node = node
    this._protocol = protocol
    this._alias = alias
    this._remoteAlias = remoteAlias
    this._keyPair = keyPair
    this._custodial = keyPair.secretKey !== null
    this._closed = false

    this._firewall = new FirewallProxy(node, protocol, alias)
    this._signee = new SigneeProxy(
      node,
      protocol,
      crypto.hash(keyPair.publicKey),
      remoteAlias
    )

    this._onStreamClose = onStreamClose.bind(this)

    this._protocol._stream
      .once('close', this._onStreamClose)

    this._onServerClose = onServerClose.bind(this)
    this._onServerListening = onServerListening.bind(this)
    this._onServerConnection = onServerConnection.bind(this)
    this._onClose = onClose.bind(this)

    this._start(0)
  }

  _start (attempt) {
    if (this._closed) return
    const keyPair = this._keyPair
    debug('listen', attempt, keyPair.publicKey.toString('hex').slice(0, 8))

    this._server = this._node._dht.createServer({
      firewall: this._custodial ? this._firewall._deny : null,
      createHandshake: this._custodial ? null : createHandshake.bind(this),
      createSecretStream: this._custodial ? null : createSecretStream.bind(this)
    })

    this._server
      .once('listening', this._onServerListening)
      .on('connection', this._onServerConnection)

    this._server.listen({
      publicKey: keyPair.publicKey,
      secretKey: keyPair.secretKey
    }, {
      signAnnounce: this._custodial ? null : this._signee._signAnnounce,
      signUnannounce: this._custodial ? null : this._signee._signUnannounce
    }).then(() => {
      debug('listening', keyPair.publicKey.toString('hex').slice(0, 8))
      if (this._closed) return
      this._server.once('close', this._onServerClose)
    }, (err) => {
      debug('listen failed', err && (err.code || err.message))
      const server = this._server
      server
        .off('listening', this._onServerListening)
        .off('connection', this._onServerConnection)
      server.close().catch(() => {})
      if (this._closed) return
      if (err && err.code === 'KEYPAIR_ALREADY_USED' && attempt < LISTEN_RETRIES) {
        setTimeout(() => this._start(attempt + 1), LISTEN_RETRY_MS)
        return
      }
      this._closed = true
      this._node._servers.delete(this._remoteAlias)
      this._protocol.listenError.send({ remoteAlias: this._remoteAlias, error: (err && (err.code || err.message)) || 'listen failed' })
    })
  }
}

module.exports = {
  ServerProxy
}

function onStreamClose () {
  debug('client gone, closing server', this._keyPair.publicKey.toString('hex').slice(0, 8))
  this._closed = true
  if (this._server) this._server.close().catch(() => {})
}

function onServerClose () {
  debug('server closed', this._keyPair.publicKey.toString('hex').slice(0, 8))
  this._closed = true
  this._protocol.closed.send({ alias: this._alias })

  this._server
    .off('listening', this._onServerListening)
    .off('connection', this._onServerConnection)

  this._node._servers.delete(this._remoteAlias)
}

function onServerListening () {
  const address = this._server.address()

  this._protocol.listening.send({
    alias: this._alias,
    remoteAlias: this._remoteAlias,
    host: address.host,
    port: address.port
  })
}

function onServerConnection (stream) {
  const alias = nextId()

  // HUWA FORK: per-client connection limit and backpressure (see NodeProxy).
  if (this._node._streams.size >= this._node._limits.maxConnections) {
    this._node._refuse('connections')
    stream.destroy()
    return
  }
  this._node.stats.incoming++
  this._node._track(stream)

  this._node._connecting.set(alias, stream)

  const onError = (err) => {
    this._protocol.destroy.send({ alias, error: err.message })
  }

  const onClose = () => {
    stream
      .off('error', onError)
      .off('end', onEnd)
      .off('data', onData)

    this._node._connecting.delete(alias)
  }

  const onEnd = () => {
    this._protocol.end.send({ alias })
  }

  const onData = (data) => {
    this._node._sendData(alias, data)
  }

  stream
    .once('error', onError)
    .once('close', onClose)
    .once('end', onEnd)
    .on('data', onData)

  this._protocol.connection.send({
    custodial: this._custodial,
    alias,
    serverAlias: this._alias,
    remotePublicKey: stream.remotePublicKey,
    handshakeHash: stream.handshakeHash,
    handshakeId: stream.handshakeId
  })
}

function onClose () {
  debug('client closes server', this._keyPair.publicKey.toString('hex').slice(0, 8), 'closed?', this._closed)
  if (!this._server) return
  // Closing before `listening`: report it like a close once the listen settles.
  if (this._closed) return this._protocol.closed.send({ alias: this._alias })
  this._server.close().catch(() => {})
}

function createHandshake (keyPair, remotePublicKey) {
  const isInitiator = !!remotePublicKey

  const id = nextId()

  const handshake = new HandshakeProxy(
    this._node,
    this._protocol,
    id,
    null,
    this._alias,
    isInitiator,
    keyPair,
    remotePublicKey
  )

  this._node._handshakes.set(id, handshake)

  return handshake
}

function createSecretStream (isInitiator, rawStream, options) {
  return new StreamProxy(
    this._protocol,
    null,
    null,
    isInitiator,
    rawStream,
    options
  )
}
