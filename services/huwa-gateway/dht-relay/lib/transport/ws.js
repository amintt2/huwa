const { Duplex } = require('streamx')
const buffer = require('b4a')

// HUWA FORK: backpressure and an optional bandwidth limit.
//   - writes wait while the socket's bufferedAmount is above `highWaterMark`, so a slow client
//     backs up the relay protocol stream (and the relay pauses the UDX streams feeding it) instead
//     of piling frames in memory;
//   - `bytesPerSecond` (+ `burst`) is a token bucket shared by both directions: writes wait for
//     tokens, and incoming frames past the budget pause the underlying TCP socket (Node `ws`).
const DEFAULT_HWM = 1024 * 1024
const POLL_MS = 10

class Stream extends Duplex {
  constructor (isInitiator, socket, options = {}) {
    super()

    this._socket = socket
    this._socket.binaryType = 'arraybuffer'

    this._opening = null
    this._highWaterMark = options.highWaterMark || DEFAULT_HWM
    this._rate = options.bytesPerSecond || 0
    this._burst = options.burst || this._rate * 4
    this._tokens = this._burst
    this._refilled = Date.now()
    this._inboundPaused = null
    this.bytesIn = 0
    this.bytesOut = 0
    this.lastActivity = Date.now()

    this._onError = onError.bind(this)
    this._onClose = onClose.bind(this)
    this._onOpen = onOpen.bind(this)
    this._onMessage = onMessage.bind(this)

    this._socket.addEventListener('error', this._onError)
    this._socket.addEventListener('close', this._onClose)
    this._socket.addEventListener('open', this._onOpen)
    this._socket.addEventListener('message', this._onMessage)
  }

  _open (cb) {
    if (this._socket.readyState > 1) cb(new Error('Socket is closed'))
    else if (this._socket.readyState < 1) this._opening = cb
    else cb(null)
  }

  _continueOpen (err) {
    if (err) this.destroy(err)

    const cb = this._opening

    if (cb) {
      this._opening = null
      this._open(cb)
    }
  }

  _take (bytes) {
    if (!this._rate) return 0
    const now = Date.now()
    this._tokens = Math.min(this._burst, this._tokens + ((now - this._refilled) * this._rate) / 1000)
    this._refilled = now
    this._tokens -= bytes
    return this._tokens >= 0 ? 0 : Math.ceil((-this._tokens * 1000) / this._rate)
  }

  _write (data, cb) {
    if (this._socket.readyState !== 1) return cb(new Error('Socket is closed'))
    this._socket.send(data)
    this.bytesOut += data.byteLength
    this.lastActivity = Date.now()
    const wait = this._take(data.byteLength)
    if (wait === 0 && !(this._socket.bufferedAmount > this._highWaterMark)) return cb(null)
    this._wait(wait, cb)
  }

  _wait (ms, cb) {
    const check = () => {
      if (this.destroying || this._socket.readyState !== 1) return cb(null)
      if (this._socket.bufferedAmount > this._highWaterMark / 2) return setTimeout(check, POLL_MS)
      cb(null)
    }
    setTimeout(check, Math.max(ms, POLL_MS))
  }

  _predestroy () {
    this._continueOpen(new Error('Socket was destroyed'))
  }

  _destroy (cb) {
    if (this._inboundPaused) clearTimeout(this._inboundPaused)
    this._socket.close()
    cb(null)
  }
}

module.exports = Stream

function onError (err) {
  this.destroy(err)
}

function onClose () {
  this._socket.removeEventListener('error', this._onError)
  this._socket.removeEventListener('close', this._onClose)
  this._socket.removeEventListener('open', this._onOpen)
  this._socket.removeEventListener('message', this._onMessage)

  this.destroy()
}

function onOpen () {
  this._continueOpen()
}

function onMessage (event) {
  const data = buffer.from(event.data)
  this.bytesIn += data.byteLength
  this.lastActivity = Date.now()
  const wait = this._take(data.byteLength)
  // Node `ws` only: stop reading the TCP socket until the budget is back.
  const tcp = this._socket._socket
  if (wait > 0 && tcp && typeof tcp.pause === 'function' && !this._inboundPaused) {
    tcp.pause()
    this._inboundPaused = setTimeout(() => {
      this._inboundPaused = null
      if (!tcp.destroyed) tcp.resume()
    }, wait)
  }
  this.push(data)
}
