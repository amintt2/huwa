const EventEmitter = require('events')
const Protomux = require('protomux')

const m = require('./messages')

const heartbeatFrequency = 15 * 1e3

class Protocol extends EventEmitter {
  constructor (stream, options = {}) {
    super()

    // HUWA FORK: `guard(name, message)` runs before any listener; returning false drops the
    // message (the relay refuses custodial messages this way).
    this._guard = options.guard || null

    const muxer = Protomux.from(stream)

    this._stream = muxer.stream.setMaxListeners(0)

    this._heartbeat = null
    this._failsafe = null

    this._onStreamClose = onStreamClose.bind(this)

    this._stream
      .once('close', this._onStreamClose)

    const opening = new Promise((resolve, reject) => {
      const onOpen = () => {
        this._stream.off('error', onError)
        resolve()
      }

      const onError = (error) => {
        this._stream.off('open', onOpen)
        reject(error)
      }

      this._stream
        .once('open', onOpen)
        .once('error', onError)
    })

    this.ready = async function ready () {
      await opening
    }

    const channel = muxer.createChannel({ protocol: '@hyperswarm/dht-relay' })

    this.handshake = channel.addMessage({
      encoding: m.handshake,
      onmessage: this._dispatch.bind(this, 'handshake')
    })

    this.ping = channel.addMessage({
      encoding: m.ping,
      onmessage: () => {
        this.pong.send()
        this.alive()
      }
    })

    this.pong = channel.addMessage({
      encoding: m.pong,
      onmessage: () => {
        this.alive()
      }
    })

    this.connect = channel.addMessage({
      encoding: m.connect,
      onmessage: this._dispatch.bind(this, 'connect')
    })

    this.connection = channel.addMessage({
      encoding: m.connection,
      onmessage: this._dispatch.bind(this, 'connection')
    })

    this.connected = channel.addMessage({
      encoding: m.connected,
      onmessage: this._dispatch.bind(this, 'connected')
    })

    this.incoming = channel.addMessage({
      encoding: m.incoming,
      onmessage: this._dispatch.bind(this, 'incoming')
    })

    this.deny = channel.addMessage({
      encoding: m.deny,
      onmessage: this._dispatch.bind(this, 'deny')
    })

    this.accept = channel.addMessage({
      encoding: m.accept,
      onmessage: this._dispatch.bind(this, 'accept')
    })

    this.destroy = channel.addMessage({
      encoding: m.destroy,
      onmessage: this._dispatch.bind(this, 'destroy')
    })

    this.listen = channel.addMessage({
      encoding: m.listen,
      onmessage: this._dispatch.bind(this, 'listen')
    })

    this.listening = channel.addMessage({
      encoding: m.listening,
      onmessage: this._dispatch.bind(this, 'listening')
    })

    this.close = channel.addMessage({
      encoding: m.close,
      onmessage: this._dispatch.bind(this, 'close')
    })

    this.closed = channel.addMessage({
      encoding: m.closed,
      onmessage: this._dispatch.bind(this, 'closed')
    })

    this.open = channel.addMessage({
      encoding: m.open,
      onmessage: this._dispatch.bind(this, 'open')
    })

    this.end = channel.addMessage({
      encoding: m.end,
      onmessage: this._dispatch.bind(this, 'end')
    })

    this.data = channel.addMessage({
      encoding: m.data,
      onmessage: this._dispatch.bind(this, 'data')
    })

    this.result = channel.addMessage({
      encoding: m.result,
      onmessage: this._dispatch.bind(this, 'result')
    })

    this.finished = channel.addMessage({
      encoding: m.finished,
      onmessage: this._dispatch.bind(this, 'finished')
    })

    this.lookup = channel.addMessage({
      encoding: m.lookup,
      onmessage: this._dispatch.bind(this, 'lookup')
    })

    this.announce = channel.addMessage({
      encoding: m.announce,
      onmessage: this._dispatch.bind(this, 'announce')
    })

    this.unannounce = channel.addMessage({
      encoding: m.unannounce,
      onmessage: this._dispatch.bind(this, 'unannounce')
    })

    this.signAnnounce = channel.addMessage({
      encoding: m.signAnnounce,
      onmessage: this._dispatch.bind(this, 'signAnnounce')
    })

    this.signUnannounce = channel.addMessage({
      encoding: m.signUnannounce,
      onmessage: this._dispatch.bind(this, 'signUnannounce')
    })

    this.signature = channel.addMessage({
      encoding: m.signature,
      onmessage: this._dispatch.bind(this, 'signature')
    })

    this.noiseSend = channel.addMessage({
      encoding: m.noiseSend,
      onmessage: this._dispatch.bind(this, 'noiseSend')
    })

    this.noiseReceive = channel.addMessage({
      encoding: m.noiseReceive,
      onmessage: this._dispatch.bind(this, 'noiseReceive')
    })

    this.noiseReply = channel.addMessage({
      encoding: m.noiseReply,
      onmessage: this._dispatch.bind(this, 'noiseReply')
    })

    // HUWA FORK: appended last, so the upstream message ids above do not move.
    for (const name of ['mutablePut', 'mutablePutReply', 'mutableGet', 'mutableGetReply', 'listenError']) {
      this[name] = channel.addMessage({
        encoding: m[name],
        onmessage: this._dispatch.bind(this, name)
      })
    }

    channel.open()
  }

  _dispatch (name, message) {
    if (this._guard !== null && this._guard(name, message) === false) return
    // HUWA FORK: a throwing handler used to escape into the transport's push() and leave the
    // stream's read loop broken: every later message was silently dropped (a relay client that
    // stopped answering signature requests, so its servers never closed).
    try {
      this.emit(name, message)
    } catch (err) {
      if (typeof process !== 'undefined' && process.env && process.env.HUWA_RELAY_DEBUG) console.log('[proto ' + (this._debugName || 'relay') + '] handler error', name, err && err.stack)
      this.emit('handler-error', err, name)
    }
  }

  heartbeat () {
    if (!this._heartbeat) {
      this._heartbeat = setInterval(() => this.ping.send(), heartbeatFrequency)
    }
    return this
  }

  alive () {
    if (this._failsafe) clearTimeout(this._failsafe)
    this._failsafe = setTimeout(() => this._stream.destroy(), heartbeatFrequency * 3)
    return this
  }
}

module.exports = {
  Protocol
}

function onStreamClose () {
  clearInterval(this._heartbeat)

  if (this._failsafe) clearTimeout(this._failsafe)
}
