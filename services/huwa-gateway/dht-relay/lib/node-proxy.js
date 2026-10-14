const { encode } = require('compact-encoding')

const { HandshakeProxy } = require('./handshake-proxy')
const { ServerProxy } = require('./server-proxy')
const { SigneeProxy } = require('./signee-proxy')
const { StreamProxy } = require('./stream-proxy')

const { announcers } = require('./codecs')
const { nextId } = require('./id')
const { verifyMutable, MAX_VALUE } = require('./mutable')

// HUWA FORK: per relay-client limits. A browser runs one Hyperswarm per relay connection: it
// needs one server, a few dozen peer connections and a handful of concurrent queries.
const DEFAULT_LIMITS = {
  maxConnections: 64, // live peer streams (outgoing + incoming)
  maxServers: 2,
  maxQueries: 32, // concurrent lookup / announce / unannounce
  mutablePerMinute: 60, // mutablePut + mutableGet
  maxMutableValue: MAX_VALUE
}

class NodeProxy {
  constructor (dht, protocol, defaultKeyPair, options = {}) {
    this._dht = dht
    this._protocol = protocol
    this._defaultKeyPair = defaultKeyPair
    this._limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) }
    this._onlimit = options.onlimit || noop
    this.stats = { connects: 0, incoming: 0, queries: 0, mutablePuts: 0, mutableGets: 0, refused: 0, bytesToClient: 0 }

    this._servers = new Map()
    this._queries = new Map()
    this._connecting = new Map()
    this._connections = new Map()
    this._handshakes = new Map()
    this._signatures = new Map()
    // HUWA FORK: every hyperdht stream relayed for this client, for limits and backpressure.
    this._streams = new Set()
    this._paused = false
    this._mutableTokens = this._limits.mutablePerMinute
    this._mutableRefill = Date.now()
    this._closed = false

    this._onStreamClose = onStreamClose.bind(this)
    this._onStreamDrain = onStreamDrain.bind(this)

    this._protocol._stream
      .once('close', this._onStreamClose)
      .on('drain', this._onStreamDrain)

    this._onConnect = onConnect.bind(this)
    this._onConnected = onConnected.bind(this)
    this._onDeny = onDeny.bind(this)
    this._onAccept = onAccept.bind(this)
    this._onListen = onListen.bind(this)
    this._onDestroy = onDestroy.bind(this)
    this._onEnd = onEnd.bind(this)
    this._onData = onData.bind(this)
    this._onQuery = onQuery.bind(this)
    this._onLookup = onLookup.bind(this)
    this._onAnnounce = onAnnounce.bind(this)
    this._onUnannounce = onUnannounce.bind(this)
    this._onClose = onClose.bind(this)
    this._onSignature = onSignature.bind(this)
    this._onNoiseReply = onNoiseReply.bind(this)
    this._onMutablePut = onMutablePut.bind(this)
    this._onMutableGet = onMutableGet.bind(this)

    this._protocol
      .on('connect', this._onConnect)
      .on('connected', this._onConnected)
      .on('deny', this._onDeny)
      .on('accept', this._onAccept)
      .on('listen', this._onListen)
      .on('destroy', this._onDestroy)
      .on('end', this._onEnd)
      .on('data', this._onData)
      .on('lookup', this._onLookup)
      .on('announce', this._onAnnounce)
      .on('unannounce', this._onUnannounce)
      .on('close', this._onClose)
      .on('signature', this._onSignature)
      .on('noiseReply', this._onNoiseReply)
      .on('mutablePut', this._onMutablePut)
      .on('mutableGet', this._onMutableGet)
  }

  // HUWA FORK: the relay client is the only consumer of what its peers send; when its WebSocket
  // backs up, stop reading from the UDX streams instead of buffering without bound.
  _track (stream) {
    this._streams.add(stream)
    stream.once('close', () => this._streams.delete(stream))
    if (this._paused) pauseStream(stream)
  }

  _sendData (alias, data) {
    this.stats.bytesToClient += data.byteLength
    if (!this._protocol.data.send({ alias, data: [data] }) && !this._paused) {
      this._paused = true
      for (const s of this._streams) pauseStream(s)
    }
  }

  _refuse (what) {
    this.stats.refused++
    this._onlimit(what)
  }

  _takeMutableToken () {
    const now = Date.now()
    const perMs = this._limits.mutablePerMinute / 60000
    this._mutableTokens = Math.min(this._limits.mutablePerMinute, this._mutableTokens + (now - this._mutableRefill) * perMs)
    this._mutableRefill = now
    if (this._mutableTokens < 1) return false
    this._mutableTokens--
    return true
  }
}

module.exports = {
  NodeProxy,
  DEFAULT_LIMITS
}

function noop () {}

function pauseStream (s) {
  const raw = s.rawStream || s
  if (typeof raw.pause === 'function') raw.pause()
}

function resumeStream (s) {
  const raw = s.rawStream || s
  if (typeof raw.resume === 'function') raw.resume()
}

function onStreamDrain () {
  if (!this._paused) return
  this._paused = false
  for (const s of this._streams) resumeStream(s)
}

function onStreamClose () {
  this._closed = true
  this._protocol._stream.off('drain', this._onStreamDrain)

  this._protocol
    .off('connect', this._onConnect)
    .off('connected', this._onConnected)
    .off('deny', this._onDeny)
    .off('accept', this._onAccept)
    .off('listen', this._onListen)
    .off('destroy', this._onDestroy)
    .off('end', this._onEnd)
    .off('data', this._onData)
    .off('lookup', this._onLookup)
    .off('announce', this._onAnnounce)
    .off('unannounce', this._onUnannounce)
    .off('close', this._onClose)
    .off('signature', this._onSignature)
    .off('noiseReply', this._onNoiseReply)
    .off('mutablePut', this._onMutablePut)
    .off('mutableGet', this._onMutableGet)

  for (const connection of this._connections.values()) {
    connection.destroy()
  }
  for (const stream of this._streams) stream.destroy()
  for (const query of this._queries.values()) query.destroy()
  // HUWA FORK: pending signature requests would keep hyperdht announcers waiting forever.
  for (const s of this._signatures.values()) if (s.reject) s.reject(new Error('Relay client gone'))
  this._signatures.clear()
}

function onConnect (message) {
  const remoteAlias = message.alias
  const alias = nextId()

  if (this._streams.size >= this._limits.maxConnections) {
    this._refuse('connections')
    this._protocol.destroy.send({ paired: false, alias, remoteAlias, error: 'Relay connection limit reached' })
    return
  }

  const custodial = message.secretKey !== null
  this.stats.connects++

  const stream = this._dht.connect(message.remotePublicKey, {
    keyPair: {
      publicKey: message.publicKey,
      secretKey: message.secretKey
    },
    createHandshake: custodial
      ? null
      : createHandshake.bind(this, remoteAlias),
    createSecretStream: custodial
      ? null
      : createSecretStream.bind(this, alias, remoteAlias)
  })

  this._connections.set(remoteAlias, stream)
  this._track(stream)

  let paired = false

  const onError = (err) => {
    this._protocol.destroy.send({
      paired,
      alias,
      remoteAlias,
      error: err.message
    })
  }

  const onClose = () => {
    stream
      .off('error', onError)
      .off('open', onOpen)
      .off('end', onEnd)
      .off('data', onData)

    this._connections.delete(remoteAlias)
  }

  const onOpen = () => {
    paired = true

    this._protocol.open.send({
      custodial,
      alias,
      remoteAlias,
      handshakeHash: stream.handshakeHash,
      handshakeId: stream.handshakeId
    })
  }

  const onEnd = () => {
    this._protocol.end.send({ alias })
  }

  const onData = (data) => {
    this._sendData(alias, data)
  }

  stream
    .once('error', onError)
    .once('close', onClose)
    .once('open', onOpen)
    .once('end', onEnd)
    .on('data', onData)
}

function onConnected (message) {
  const stream = this._connecting.get(message.remoteAlias)

  if (stream) {
    this._connecting.delete(message.remoteAlias)
    this._connections.set(message.alias, stream)

    const onClose = () => {
      this._connections.delete(message.alias)
    }

    stream
      .once('close', onClose)
  }
}

function onDeny (message) {
  for (const server of this._servers.values()) {
    const request = server._firewall._requests.get(message.id)

    if (request) return server._firewall._onDeny(message)
  }
}

function onAccept (message) {
  for (const server of this._servers.values()) {
    const request = server._firewall._requests.get(message.id)

    if (request) return server._firewall._onAccept(message)
  }
}

function onListen (message) {
  const remoteAlias = message.alias

  if (this._servers.size >= this._limits.maxServers) {
    this._refuse('servers')
    this._protocol._stream.destroy(new Error('Relay server limit reached'))
    return
  }

  const alias = nextId()

  const server = new ServerProxy(this, this._protocol, alias, remoteAlias, message)

  this._servers.set(remoteAlias, server)
}

function onDestroy (message) {
  const stream = this._connections.get(message.alias)

  if (stream) {
    stream.destroy(message.error && new Error(message.error))
  }
}

function onEnd (message) {
  const stream = this._connections.get(message.alias)

  if (stream) stream.end()
}

function onData (message) {
  const stream = this._connections.get(message.alias)

  if (stream) {
    for (const chunk of message.data) stream.write(chunk)
  }
}

function onQuery (message, query, encoding) {
  this._queries.set(message.id, query)
  this.stats.queries++

  const onError = () => {
    // Errors end the query: onClose reports it finished.
  }

  const onClose = () => {
    query
      .off('error', onError)
      .off('data', onData)

    this._queries.delete(message.id)
    if (!this._closed) this._protocol.finished.send(message)
  }

  const onData = (data) => {
    this._protocol.result.send({
      id: message.id,
      data: encode(encoding, data)
    })
  }

  query
    .once('error', onError)
    .once('close', onClose)
    .on('data', onData)
}

function tooManyQueries (message) {
  if (this._queries.size < this._limits.maxQueries) return false
  this._refuse('queries')
  this._protocol.finished.send(message)
  return true
}

function onLookup (message) {
  if (tooManyQueries.call(this, message)) return

  this._onQuery(
    message,
    this._dht.lookup(message.topic),
    announcers
  )
}

function onAnnounce (message) {
  if (tooManyQueries.call(this, message)) return

  const custodial = message.secretKey !== null

  const signee = new SigneeProxy(
    this,
    this._protocol,
    message.topic,
    message.id
  )

  this._onQuery(
    message,
    this._dht.announce(message.topic, {
      publicKey: message.publicKey,
      secretKey: message.secretKey
    }, [], {
      signAnnounce: custodial ? null : signee._signAnnounce,
      signUnannounce: custodial ? null : signee._signUnannounce
    }),
    announcers
  )
}

function onUnannounce (message) {
  if (tooManyQueries.call(this, message)) return

  const custodial = message.secretKey !== null

  const signee = new SigneeProxy(
    this,
    this._protocol,
    message.topic,
    message.id
  )

  this._onQuery(
    message,
    this._dht.lookupAndUnannounce(message.topic, {
      publicKey: message.publicKey,
      secretKey: message.secretKey
    }, {
      signAnnounce: custodial ? null : signee._signAnnounce,
      signUnannounce: custodial ? null : signee._signUnannounce
    }),
    announcers
  )
}

function onClose (message) {
  const server = this._servers.get(message.alias)

  if (server) server._onClose(message)
}

function onSignature (message) {
  const signature = this._signatures.get(message.id)

  if (signature) {
    this._signatures.delete(message.id)
    signature.resolve(message.signature)
  }
}

function onNoiseReply (message) {
  const handshake = this._handshakes.get(message.id)

  if (handshake) handshake._onNoiseReply(message)
}

// HUWA FORK: mutable records. The client signs; the relay checks the signature before it touches
// the DHT (it stores exactly what was signed, through hyperdht's signMutable hook) and never needs
// the key. Values are bounded and rate limited per client.
async function onMutablePut (message) {
  const reply = (error) => {
    if (!this._closed) this._protocol.mutablePutReply.send({ id: message.id, error })
  }
  if (!this._takeMutableToken()) {
    this._refuse('mutable')
    return reply('Rate limited')
  }
  const { publicKey, seq, value, signature } = message
  if (!value || value.byteLength > this._limits.maxMutableValue) return reply('Value too large')
  if (!verifyMutable(signature, seq, value, publicKey)) return reply('Bad signature')
  this.stats.mutablePuts++
  try {
    await this._dht.mutablePut({ publicKey }, value, { seq, signMutable: () => signature })
    reply(null)
  } catch (err) {
    reply(err.message || 'mutablePut failed')
  }
}

async function onMutableGet (message) {
  const reply = (m) => {
    if (!this._closed) this._protocol.mutableGetReply.send({ id: message.id, ...m })
  }
  if (!this._takeMutableToken()) {
    this._refuse('mutable')
    return reply({ found: false, error: 'Rate limited' })
  }
  this.stats.mutableGets++
  try {
    const node = await this._dht.mutableGet(message.publicKey, { seq: message.seq, latest: message.latest })
    if (!node) return reply({ found: false })
    reply({ found: true, seq: node.seq, value: node.value, signature: node.signature })
  } catch (err) {
    reply({ found: false, error: err.message || 'mutableGet failed' })
  }
}

function createHandshake (remoteStreamAlias, keyPair, remotePublicKey) {
  const isInitiator = !!remotePublicKey

  const id = nextId()

  const handshake = new HandshakeProxy(
    this,
    this._protocol,
    id,
    remoteStreamAlias,
    null,
    isInitiator,
    keyPair,
    remotePublicKey
  )

  this._handshakes.set(id, handshake)

  return handshake
}

function createSecretStream (alias, remoteAlias, isInitiator, rawStream, options) {
  return new StreamProxy(
    this._protocol,
    alias,
    remoteAlias,
    isInitiator,
    rawStream,
    options
  )
}
