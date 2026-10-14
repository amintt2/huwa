// One column family in memory: the sorted array of its live hex keys (the key index, always fully
// in memory) and its dirty values (written, not yet compacted into IndexedDB's `kv` store; pinned).
// Clean values live in IndexedDB and in the shared LRU cache (see index.js).
//
// Hex (lowercase, 2 chars per byte) keeps the byte order of RocksDB's default bytewise comparator
// under plain string comparison, prefixes included, so JS string compares are enough.
// Stored values are immutable: writers store copies, readers get copies.

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
    this.prefix = name + '/' // IndexedDB key prefix
    this.keys = [] // sorted hex
    this.dirty = new Map() // hex -> { value, seq } (seq: WAL record holding it, Infinity in memory mode)
  }

  get size() {
    return this.keys.length
  }

  has(hex) {
    const keys = this.keys
    const n = keys.length
    if (n === 0) return false
    if (keys[n - 1] === hex) return true
    const i = lowerBound(keys, hex)
    return i < n && keys[i] === hex
  }

  /** Inserts a key known to be absent. */
  insert(hex) {
    const n = this.keys.length
    // Appends at the end are the common case (block / tree indexes grow).
    if (n === 0 || this.keys[n - 1] < hex) this.keys.push(hex)
    else this.keys.splice(lowerBound(this.keys, hex), 0, hex)
  }

  /** Removes a key; returns whether it was there. */
  remove(hex) {
    const i = lowerBound(this.keys, hex)
    if (i >= this.keys.length || this.keys[i] !== hex) return false
    this.keys.splice(i, 1)
    return true
  }

  /** Keys in [start, end). */
  range(start, end) {
    if (!(start < end)) return []
    return this.keys.slice(lowerBound(this.keys, start), lowerBound(this.keys, end))
  }

  /** Removes [start, end) and returns the removed keys. */
  removeRange(start, end) {
    if (!(start < end)) return []
    const i = lowerBound(this.keys, start)
    const j = lowerBound(this.keys, end)
    if (i >= j) return []
    return this.keys.splice(i, j - i)
  }

  /**
   * Next key strictly after `after` (or from the start of the bounds when `after` is null),
   * within bounds; null when none. Bounds: { gt, gte, lt, lte } as hex or null.
   */
  next(after, b, reverse) {
    return nextInSorted(this.keys, after, b, reverse)
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

module.exports = { Table, lowerBound, upperBound, inLower, inUpper, nextInSorted }
