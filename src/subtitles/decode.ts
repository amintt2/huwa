// Bytes → text for subtitle files found in the wild:
//   - gzip (OpenSubtitles & co. often serve `.srt.gz`) → inflated first
//   - UTF-8 (with or without BOM), UTF-16 LE/BE (BOM or zero-byte pattern)
//   - legacy single-byte code pages, guessed by scoring: Windows-1252 (Western Europe),
//     Windows-1250 (Central Europe), Windows-1251 (Cyrillic)
//   - anything else: the platform `TextDecoder` when it knows the label (CJK code pages)
// Pure JS (Hermes has no complete `TextDecoder`), so it runs the same in the app and in tests.
import { gunzipSync } from 'fflate';

export type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252' | 'windows-1250' | 'windows-1251' | 'shift_jis' | 'gbk' | 'big5' | 'euc-kr';

export const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

// ---------- code page tables (0x80..0xFF) ----------

const U = 0xfffd;
// prettier-ignore
const CP1252_80 = [
  0x20ac, U, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, U, 0x017d, U,
  U, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, U, 0x017e, 0x0178,
];
// prettier-ignore
const CP1250_80 = [
  0x20ac, U, 0x201a, U, 0x201e, 0x2026, 0x2020, 0x2021, U, 0x2030, 0x0160, 0x2039, 0x015a, 0x0164, 0x017d, 0x0179,
  U, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, U, 0x2122, 0x0161, 0x203a, 0x015b, 0x0165, 0x017e, 0x017a,
  0x00a0, 0x02c7, 0x02d8, 0x0141, 0x00a4, 0x0104, 0x00a6, 0x00a7, 0x00a8, 0x00a9, 0x015e, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x017b,
  0x00b0, 0x00b1, 0x02db, 0x0142, 0x00b4, 0x00b5, 0x00b6, 0x00b7, 0x00b8, 0x0105, 0x015f, 0x00bb, 0x013d, 0x02dd, 0x013e, 0x017c,
  0x0154, 0x00c1, 0x00c2, 0x0102, 0x00c4, 0x0139, 0x0106, 0x00c7, 0x010c, 0x00c9, 0x0118, 0x00cb, 0x011a, 0x00cd, 0x00ce, 0x010e,
  0x0110, 0x0143, 0x0147, 0x00d3, 0x00d4, 0x0150, 0x00d6, 0x00d7, 0x0158, 0x016e, 0x00da, 0x0170, 0x00dc, 0x00dd, 0x0162, 0x00df,
  0x0155, 0x00e1, 0x00e2, 0x0103, 0x00e4, 0x013a, 0x0107, 0x00e7, 0x010d, 0x00e9, 0x0119, 0x00eb, 0x011b, 0x00ed, 0x00ee, 0x010f,
  0x0111, 0x0144, 0x0148, 0x00f3, 0x00f4, 0x0151, 0x00f6, 0x00f7, 0x0159, 0x016f, 0x00fa, 0x0171, 0x00fc, 0x00fd, 0x0163, 0x02d9,
];
// prettier-ignore
const CP1251_80 = [
  0x0402, 0x0403, 0x201a, 0x0453, 0x201e, 0x2026, 0x2020, 0x2021, 0x20ac, 0x2030, 0x0409, 0x2039, 0x040a, 0x040c, 0x040b, 0x040f,
  0x0452, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, U, 0x2122, 0x0459, 0x203a, 0x045a, 0x045c, 0x045b, 0x045f,
  0x00a0, 0x040e, 0x045e, 0x0408, 0x00a4, 0x0490, 0x00a6, 0x00a7, 0x0401, 0x00a9, 0x0404, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x0407,
  0x00b0, 0x00b1, 0x0406, 0x0456, 0x0491, 0x00b5, 0x00b6, 0x00b7, 0x0451, 0x2116, 0x0454, 0x00bb, 0x0458, 0x0405, 0x0455, 0x0457,
];

const TABLES: Record<'windows-1252' | 'windows-1250' | 'windows-1251', (b: number) => number> = {
  'windows-1252': (b) => (b < 0xa0 ? CP1252_80[b - 0x80] : b),
  'windows-1250': (b) => CP1250_80[b - 0x80],
  'windows-1251': (b) => (b < 0xc0 ? CP1251_80[b - 0x80] : 0x0410 + (b - 0xc0)),
};

function fromCodes(codes: ArrayLike<number>, n: number): string {
  let out = '';
  const CHUNK = 8192;
  for (let i = 0; i < n; i += CHUNK) {
    out += String.fromCharCode.apply(null, Array.prototype.slice.call(codes, i, Math.min(n, i + CHUNK)) as number[]);
  }
  return out;
}

export function decodeSingleByte(bytes: Uint8Array, enc: keyof typeof TABLES): string {
  const map = TABLES[enc];
  const codes = new Uint16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) codes[i] = bytes[i] < 0x80 ? bytes[i] : map(bytes[i]);
  return fromCodes(codes, codes.length);
}

// ---------- UTF-8 / UTF-16 ----------

/** Strict UTF-8 decode; returns null on the first invalid sequence. */
export function decodeUtf8Strict(b: Uint8Array, start = 0): string | null {
  const codes = new Uint16Array(b.length); // UTF-16 never needs more units than UTF-8 bytes
  let n = 0;
  let i = start;
  while (i < b.length) {
    const c = b[i];
    if (c < 0x80) {
      codes[n++] = c;
      i++;
      continue;
    }
    let need: number;
    let cp: number;
    let min: number;
    if (c >= 0xc2 && c <= 0xdf) [need, cp, min] = [1, c & 0x1f, 0x80];
    else if (c >= 0xe0 && c <= 0xef) [need, cp, min] = [2, c & 0x0f, 0x800];
    else if (c >= 0xf0 && c <= 0xf4) [need, cp, min] = [3, c & 0x07, 0x10000];
    else return null;
    if (i + need >= b.length) return null;
    for (let k = 1; k <= need; k++) {
      const cc = b[i + k];
      if (cc === undefined || (cc & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (cc & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    if (cp >= 0x10000) {
      const v = cp - 0x10000;
      codes[n++] = 0xd800 + (v >> 10);
      codes[n++] = 0xdc00 + (v & 0x3ff);
    } else codes[n++] = cp;
    i += need + 1;
  }
  return fromCodes(codes, n);
}

export function decodeUtf16(b: Uint8Array, le: boolean, start = 0): string {
  const n = (b.length - start) >> 1;
  const codes = new Uint16Array(n);
  for (let k = 0; k < n; k++) {
    const i = start + k * 2;
    codes[k] = le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1];
  }
  return fromCodes(codes, n);
}

/** UTF-16 without BOM: ASCII-heavy text has a zero byte in every other position. */
function sniffUtf16(b: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(b.length - (b.length % 2), 2000);
  if (n < 8) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (b[i] === 0) evenZero++;
    if (b[i + 1] === 0) oddZero++;
  }
  const pairs = n / 2;
  if (oddZero / pairs > 0.4 && evenZero / pairs < 0.05) return 'utf-16le';
  if (evenZero / pairs > 0.4 && oddZero / pairs < 0.05) return 'utf-16be';
  return null;
}

// ---------- legacy code page guess ----------

/** Cased letter (Latin, Greek, Cyrillic…): no Unicode property escapes needed. */
const isLetter = (ch: string) => ch.toLowerCase() !== ch.toUpperCase() || ch === 'ß';
/** Punctuation that legitimately shows up in Western subtitles. */
const OK_PUNCT = new Set('«»‘’‚“”„…–—•€°¡¿· '.split(''));

/**
 * Scores a decoding of the high bytes: letters are good, stray symbols (¹ ³ ¤ ¦ ¨ ˇ …) are bad,
 * and a letter wedged between two letters counts double (real words, not mojibake).
 */
function scoreSingleByte(bytes: Uint8Array, enc: keyof typeof TABLES): number {
  const map = TABLES[enc];
  let score = 0;
  const isAsciiLetter = (x: number) => (x >= 0x41 && x <= 0x5a) || (x >= 0x61 && x <= 0x7a);
  for (let i = 0; i < bytes.length; i++) {
    const x = bytes[i];
    if (x < 0x80) continue;
    const ch = String.fromCharCode(map(x));
    const prev = i > 0 ? bytes[i - 1] : 0x20;
    const next = i + 1 < bytes.length ? bytes[i + 1] : 0x20;
    const inWord = (isAsciiLetter(prev) || prev >= 0x80) && (isAsciiLetter(next) || next >= 0x80);
    if (ch === '�') score -= 5;
    else if (isLetter(ch)) score += inWord ? 2 : 1;
    else if (OK_PUNCT.has(ch)) score += inWord && (ch === '¿' || ch === '·') ? -3 : 0.5;
    else score -= 3;
  }
  return score;
}

/** Cyrillic text encodes nearly every letter as a high byte, in long runs. */
function looksCyrillic1251(bytes: Uint8Array): boolean {
  let high = 0;
  let ascii = 0;
  let runs = 0;
  let inRun = false;
  for (const x of bytes) {
    if (x >= 0xc0) {
      high++;
      if (!inRun) runs++;
      inRun = true;
    } else {
      if ((x >= 0x41 && x <= 0x5a) || (x >= 0x61 && x <= 0x7a)) ascii++;
      inRun = false;
    }
  }
  return high > 20 && high / (high + ascii) > 0.5 && high / Math.max(1, runs) > 2.5;
}

function tryPlatformDecoder(bytes: Uint8Array, label: string): string | null {
  try {
    const TD = (globalThis as { TextDecoder?: typeof TextDecoder }).TextDecoder;
    if (!TD) return null;
    return new TD(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** East Asian double-byte files (rare nowadays): only when the platform can decode them. */
function tryCjk(bytes: Uint8Array): { text: string; encoding: Encoding } | null {
  const cands: { enc: Encoding; re: RegExp }[] = [
    { enc: 'shift_jis', re: /[぀-ヿ]/g },
    { enc: 'gbk', re: /[一-鿿]/g },
    { enc: 'big5', re: /[一-鿿]/g },
    { enc: 'euc-kr', re: /[가-힯]/g },
  ];
  let best: { text: string; encoding: Encoding; score: number } | null = null;
  for (const c of cands) {
    const text = tryPlatformDecoder(bytes, c.enc);
    if (!text) continue;
    const score = (text.match(c.re)?.length ?? 0) / Math.max(1, text.length);
    if (!best || score > best.score) best = { text, encoding: c.enc, score };
  }
  return best && best.score > 0.1 ? best : null;
}

export type Decoded = { text: string; encoding: Encoding; gzip: boolean };

/** Detects gzip + text encoding and returns the text (BOM stripped, newlines untouched). */
export function decodeSubtitleBytes(input: Uint8Array): Decoded {
  let bytes = input;
  let gzip = false;
  if (isGzip(bytes)) {
    bytes = gunzipSync(bytes);
    gzip = true;
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decodeUtf8Strict(bytes, 3) ?? decodeSingleByte(bytes.subarray(3), 'windows-1252'), encoding: 'utf-8', gzip };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: decodeUtf16(bytes, true, 2), encoding: 'utf-16le', gzip };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: decodeUtf16(bytes, false, 2), encoding: 'utf-16be', gzip };
  const u16 = sniffUtf16(bytes);
  if (u16) return { text: decodeUtf16(bytes, u16 === 'utf-16le'), encoding: u16, gzip };

  const utf8 = decodeUtf8Strict(bytes);
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8', gzip };

  if (looksCyrillic1251(bytes)) return { text: decodeSingleByte(bytes, 'windows-1251'), encoding: 'windows-1251', gzip };
  const cjk = tryCjk(bytes);
  if (cjk) return { ...cjk, gzip };
  const s1252 = scoreSingleByte(bytes, 'windows-1252');
  const s1250 = scoreSingleByte(bytes, 'windows-1250');
  const enc = s1250 > s1252 ? 'windows-1250' : 'windows-1252';
  return { text: decodeSingleByte(bytes, enc), encoding: enc, gzip };
}
