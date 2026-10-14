// WAL record encoding: one record per group commit, holding the ops of every batch in it.
//   record = [version u8 = 1] [count varint] op*
//   op     = [type u8] [cf varint-len bytes] [key varint-len bytes] (put: value | range: end key)
// Lengths are unsigned LEB128 varints (safe up to 2^53).

const b4a = require('b4a')

const PUT = 1
const DELETE = 2
const DELETE_RANGE = 3
const VERSION = 1

function vlen(n) {
  let l = 1
  while (n >= 128) {
    n = Math.floor(n / 128)
    l++
  }
  return l
}

function vwrite(buf, o, n) {
  while (n >= 128) {
    buf[o++] = (n % 128) | 128
    n = Math.floor(n / 128)
  }
  buf[o++] = n
  return o
}

function blen(b) {
  return vlen(b.byteLength) + b.byteLength
}

function bwrite(buf, o, b) {
  o = vwrite(buf, o, b.byteLength)
  buf.set(b, o)
  return o + b.byteLength
}

/** ops: [{ type, cf (name), key, value?, end? }] (Uint8Array key / value / end). */
function encodeOps(ops) {
  const names = new Map()
  const name = (cf) => {
    let b = names.get(cf)
    if (b === undefined) names.set(cf, (b = b4a.from(cf)))
    return b
  }
  let size = 1 + vlen(ops.length)
  for (const op of ops) {
    size += 1 + blen(name(op.cf)) + blen(op.key)
    if (op.type === PUT) size += blen(op.value)
    else if (op.type === DELETE_RANGE) size += blen(op.end)
  }
  const buf = new Uint8Array(size) // own buffer: IndexedDB clones the whole ArrayBuffer of a view
  buf[0] = VERSION
  let o = vwrite(buf, 1, ops.length)
  for (const op of ops) {
    buf[o++] = op.type
    o = bwrite(buf, o, name(op.cf))
    o = bwrite(buf, o, op.key)
    if (op.type === PUT) o = bwrite(buf, o, op.value)
    else if (op.type === DELETE_RANGE) o = bwrite(buf, o, op.end)
  }
  return buf
}

/** Inverse of encodeOps; keys / values are copies (they outlive the record). */
function decodeOps(buf) {
  const st = { buf, o: 0 }
  if (byte(st) !== VERSION) throw new Error('Unknown WAL record version')
  const n = vread(st)
  const ops = new Array(n)
  for (let i = 0; i < n; i++) {
    const type = byte(st)
    const cf = b4a.toString(bread(st))
    const key = own(bread(st))
    if (type === PUT) ops[i] = { type, cf, key, value: own(bread(st)) }
    else if (type === DELETE) ops[i] = { type, cf, key }
    else if (type === DELETE_RANGE) ops[i] = { type, cf, key, end: own(bread(st)) }
    else throw new Error('Corrupt WAL record (op type ' + type + ')')
  }
  if (st.o !== buf.byteLength) throw new Error('Corrupt WAL record (trailing bytes)')
  return ops
}

/** Exact-size copy with its own ArrayBuffer (not a slice of a pool). */
function own(u8) {
  const out = new Uint8Array(u8.byteLength)
  out.set(u8)
  return out
}

function byte(st) {
  if (st.o >= st.buf.byteLength) throw new Error('Corrupt WAL record (truncated)')
  return st.buf[st.o++]
}

function vread(st) {
  let n = 0
  let m = 1
  let b
  do {
    b = byte(st)
    n += (b & 127) * m
    m *= 128
  } while (b & 128)
  return n
}

function bread(st) {
  const len = vread(st)
  if (st.o + len > st.buf.byteLength) throw new Error('Corrupt WAL record (truncated)')
  const out = st.buf.subarray(st.o, st.o + len)
  st.o += len
  return out
}

module.exports = { encodeOps, decodeOps, own, PUT, DELETE, DELETE_RANGE }
