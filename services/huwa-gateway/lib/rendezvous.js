// Rendezvous mailbox (/p2p/rendezvous/<topic>): a tiny store-and-forward box for the QR
// "link a browser" flow. The browser picks a random 32-byte topic, shows it in its QR code and
// long-polls the box; the phone posts the pairing invite there, sealed to the browser's ephemeral
// X25519 key. Frames are opaque to the gateway (ciphertext), at most `frameBytes` each, and every
// frame expires `ttlMs` after it was posted. Knowing the topic is the only capability.

const TOPIC = /^[0-9a-f]{64}$/

class Rendezvous {
  constructor({ ttlMs = 120_000, frameBytes = 8192, framesPerTopic = 8, maxTopics = 4096, maxWaitMs = 30_000 } = {}) {
    this.ttlMs = ttlMs
    this.frameBytes = frameBytes
    this.framesPerTopic = framesPerTopic
    this.maxTopics = maxTopics
    this.maxWaitMs = maxWaitMs
    this.topics = new Map() // topic -> { frames: [{ n, data, expires }], next, waiters: Set }
    this.stats = { posts: 0, gets: 0, expired: 0, refused: 0 }
    this._gc = setInterval(() => this.gc(), Math.min(10_000, ttlMs / 4))
    this._gc.unref()
  }

  static validTopic(topic) {
    return TOPIC.test(topic)
  }

  get size() {
    return this.topics.size
  }

  bytes() {
    let n = 0
    for (const t of this.topics.values()) for (const f of t.frames) n += f.data.byteLength
    return n
  }

  /** Stores a frame; returns its index, or throws an Error with `status` (413, 429, 503). */
  post(topic, data) {
    if (data.byteLength === 0 || data.byteLength > this.frameBytes) throw status(new Error('frame too large'), 413)
    let t = this.topics.get(topic)
    if (!t) {
      if (this.topics.size >= this.maxTopics) {
        this.gc()
        if (this.topics.size >= this.maxTopics) throw status(new Error('rendezvous full'), 503)
      }
      t = { frames: [], next: 0, waiters: new Set() }
      this.topics.set(topic, t)
    }
    if (t.frames.length >= this.framesPerTopic) throw status(new Error('topic full'), 429)
    const frame = { n: t.next++, data, expires: Date.now() + this.ttlMs }
    t.frames.push(frame)
    this.stats.posts++
    for (const w of t.waiters) w()
    return frame.n
  }

  /** Frames with n > after (after = -1 for all); waits up to `waitMs` for one if there is none. */
  async get(topic, after = -1, waitMs = 0, signal = null) {
    this.stats.gets++
    const pick = () => {
      const t = this.topics.get(topic)
      if (!t) return []
      const now = Date.now()
      return t.frames.filter((f) => f.n > after && f.expires > now)
    }
    let frames = pick()
    if (frames.length || waitMs <= 0) return frames
    let t = this.topics.get(topic)
    if (!t) {
      // Waiting creates the box (the browser polls before the phone posts).
      if (this.topics.size >= this.maxTopics) return []
      t = { frames: [], next: 0, waiters: new Set() }
      this.topics.set(topic, t)
    }
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        t.waiters.delete(done)
        if (signal) signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, Math.min(waitMs, this.maxWaitMs))
      t.waiters.add(done)
      if (signal) signal.addEventListener('abort', done)
    })
    frames = pick()
    return frames
  }

  delete(topic) {
    const t = this.topics.get(topic)
    if (!t) return false
    this.topics.delete(topic)
    for (const w of t.waiters) w()
    return true
  }

  gc() {
    const now = Date.now()
    for (const [topic, t] of this.topics) {
      const before = t.frames.length
      t.frames = t.frames.filter((f) => f.expires > now)
      this.stats.expired += before - t.frames.length
      if (!t.frames.length && t.waiters.size === 0) this.topics.delete(topic)
    }
  }

  close() {
    clearInterval(this._gc)
    for (const t of this.topics.values()) for (const w of t.waiters) w()
    this.topics.clear()
  }
}

function status(err, code) {
  err.status = code
  return err
}

module.exports = { Rendezvous }
