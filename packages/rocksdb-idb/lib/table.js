// One column family in memory: a sorted array of hex keys + a Map hex -> entry.
// Hex (lowercase, 2 chars per byte) keeps the byte order of RocksDB's default bytewise comparator
// under plain string comparison, prefixes included, so JS string compares are enough.
//
// Entries are immutable once stored ({ key, value } copies of what the caller passed): readers get
// copies again, so a caller mutating a buffer (Hypercore bitfield pages do) never touches the store.

function lowerBound(arr, x) {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBound(arr, x) {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

class Table {
  constructor(name) {
    this.name = name
    this.keys = [] // sorted hex
    this.map = new Map() // hex -> { key: Uint8Array, value: Uint8Array }
  }

  get size() {
    return this.keys.length
  }

  get(hex) {
    return this.map.get(hex) || null
  }

  /** Bulk load of keys already sorted (IndexedDB returns them in order). */
  load(hex, entry) {
    this.keys.push(hex)
    this.map.set(hex, entry)
  }

  /** Returns the previous entry (or null). */
  put(hex, entry) {
    const prev = this.map.get(hex)
    this.map.set(hex, entry)
    if (prev) return prev
    const n = this.keys.length
    // Appends at the end are the common case (block / tree indexes grow).
    if (n === 0 || this.keys[n - 1] < hex) this.keys.push(hex)
    else this.keys.splice(lowerBound(this.keys, hex), 0, hex)
    return null
  }

  /** Returns the previous entry (or null). */
  delete(hex) {
    const prev = this.map.get(hex)
    if (!prev) return null
    this.map.delete(hex)
    const i = lowerBound(this.keys, hex)
    this.keys.splice(i, 1)
    return prev
  }

  /** Deletes [start, end) and returns the removed [hex, entry] pairs. */
  deleteRange(start, end) {
    if (!(start < end)) return []
    const i = lowerBound(this.keys, start)
    const j = lowerBound(this.keys, end)
    if (i >= j) return []
    const removed = this.keys.splice(i, j - i)
    const out = new Array(removed.length)
    for (let k = 0; k < removed.length; k++) {
      const hex = removed[k]
      out[k] = [hex, this.map.get(hex)]
      this.map.delete(hex)
    }
    return out
  }

  /**
   * Next key strictly after `after` (or from the start of the bounds when `after` is null),
   * within bounds; null when none. Bounds: { gt, gte, lt, lte } as hex or null.
   */
  next(after, b, reverse) {
    const keys = this.keys
    if (!reverse) {
      let i
      if (after !== null) i = upperBound(keys, after)
      else if (b.gt !== null) i = upperBound(keys, b.gt)
      else if (b.gte !== null) i = lowerBound(keys, b.gte)
      else i = 0
      if (i >= keys.length) return null
      const k = keys[i]
      if (!inUpper(k, b)) return null
      if (!inLower(k, b)) return null
      return k
    }
    let i
    if (after !== null) i = lowerBound(keys, after) - 1
    else if (b.lt !== null) i = lowerBound(keys, b.lt) - 1
    else if (b.lte !== null) i = upperBound(keys, b.lte) - 1
    else i = keys.length - 1
    if (i < 0) return null
    const k = keys[i]
    if (!inLower(k, b)) return null
    if (!inUpper(k, b)) return null
    return k
  }
}

function inLower(k, b) {
  if (b.gt !== null && !(k > b.gt)) return false
  if (b.gte !== null && !(k >= b.gte)) return false
  return true
}

function inUpper(k, b) {
  if (b.lt !== null && !(k < b.lt)) return false
  if (b.lte !== null && !(k <= b.lte)) return false
  return true
}

/** Next element of a sorted array strictly after `after` (or first in bounds), within bounds. */
function nextInSorted(keys, after, b, reverse) {
  const t = { keys }
  return Table.prototype.next.call(t, after, b, reverse)
}

module.exports = { Table, lowerBound, upperBound, inLower, inUpper, nextInSorted }
