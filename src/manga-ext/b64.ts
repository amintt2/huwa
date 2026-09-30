// Base64 <-> bytes without relying on engine globals (Hermes / Node / tests), plus a short hash.

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHA.length; i++) LOOKUP[ALPHA.charCodeAt(i)] = i;
LOOKUP['-'.charCodeAt(0)] = 62;
LOOKUP['_'.charCodeAt(0)] = 63;

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHA[n >> 18] + ALPHA[(n >> 12) & 63] + ALPHA[(n >> 6) & 63] + ALPHA[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += ALPHA[n >> 18] + ALPHA[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHA[n >> 18] + ALPHA[(n >> 12) & 63] + ALPHA[(n >> 6) & 63] + '=';
  }
  return out;
}

/** Throws on invalid input. */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[\s=]+/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buf = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? LOOKUP[c] : -1;
    if (v < 0) throw new Error('base64 invalide');
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

// Hand-written UTF-8: TextDecoder is not guaranteed on every Hermes version.
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** Strict UTF-8 decode; undefined when the bytes are not valid UTF-8. */
export function utf8DecodeStrict(bytes: Uint8Array): string | undefined {
  let out = '';
  let chunk: number[] = [];
  const flush = () => {
    out += String.fromCharCode.apply(null, chunk);
    chunk = [];
  };
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    let cp: number;
    let n: number;
    if (b < 0x80) {
      cp = b;
      n = 1;
    } else if (b >= 0xc2 && b < 0xe0) {
      cp = b & 31;
      n = 2;
    } else if (b >= 0xe0 && b < 0xf0) {
      cp = b & 15;
      n = 3;
    } else if (b >= 0xf0 && b < 0xf5) {
      cp = b & 7;
      n = 4;
    } else return undefined;
    if (i + n > bytes.length) return undefined;
    for (let k = 1; k < n; k++) {
      const x = bytes[i + k];
      if ((x & 0xc0) !== 0x80) return undefined;
      cp = (cp << 6) | (x & 63);
    }
    if ((n === 3 && (cp < 0x800 || (cp >= 0xd800 && cp < 0xe000))) || (n === 4 && (cp < 0x10000 || cp > 0x10ffff))) return undefined;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
    } else chunk.push(cp);
    if (chunk.length > 8000) flush();
    i += n;
  }
  flush();
  return out;
}

/** FNV-1a 32-bit, base36. Stable short ids for repositories and series. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
