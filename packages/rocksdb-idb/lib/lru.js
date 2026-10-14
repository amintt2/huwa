// Byte-bounded LRU of clean (persisted) values: Map insertion order is the recency order.

const OVERHEAD = 64 // rough per-entry cost of the Map slot and the Uint8Array object

class LRU {
  constructor(maxBytes) {
    this.maxBytes = maxBytes
    this.bytes = 0
    this.map = new Map()
  }

  get size() {
    return this.map.size
  }

  /** Returns the value (and marks it recently used) or undefined. */
  get(k) {
    const v = this.map.get(k)
    if (v === undefined) return undefined
    this.map.delete(k)
    this.map.set(k, v)
    return v
  }

  /** Same as get without touching the recency order. */
  peek(k) {
    return this.map.get(k)
  }

  set(k, v) {
    this.delete(k)
    const s = cost(k, v)
    if (s > this.maxBytes) return
    this.map.set(k, v)
    this.bytes += s
    if (this.bytes <= this.maxBytes) return
    for (const [ok, ov] of this.map) {
      this.map.delete(ok)
      this.bytes -= cost(ok, ov)
      if (this.bytes <= this.maxBytes) break
    }
  }

  delete(k) {
    const v = this.map.get(k)
    if (v === undefined) return
    this.map.delete(k)
    this.bytes -= cost(k, v)
  }

  clear() {
    this.map.clear()
    this.bytes = 0
  }
}

function cost(k, v) {
  return v.byteLength + 2 * k.length + OVERHEAD
}

module.exports = { LRU }
