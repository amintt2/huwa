// OpenSubtitles hash of the playing file, as Stremio's server computes it: file size + the sum of
// the 64-bit little-endian words of its first and last 64 KiB, modulo 2^64. Subtitle addons
// (OpenSubtitles v3) answer a request carrying it with the files made for this very release, which
// are in sync. Torrent streams almost never give it (`behaviorHints.videoHash`): it is computed
// here with two range reads, through the torrent engine for a torrent (its first and last pieces
// are fetched for playback anyway: start, then the MKV index at the end).

const CHUNK = 65536;
const TWO32 = 2 ** 32;

/**
 * Hash of a file of `size` bytes from its first and last 64 KiB (16 hex digits). 64-bit sum kept
 * as two 32-bit halves (no BigInt: not every JS engine the app runs on has it).
 */
export function openSubtitlesHash(size: number, head: Uint8Array, tail: Uint8Array): string {
  let lo = size % TWO32;
  let hi = Math.floor(size / TWO32) % TWO32;
  for (const buf of [head, tail]) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i + 8 <= buf.byteLength; i += 8) {
      lo += view.getUint32(i, true);
      hi += view.getUint32(i + 4, true) + Math.floor(lo / TWO32);
      lo %= TWO32;
      hi %= TWO32;
    }
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/** "bytes 0-65535/734003200" → 734003200. */
export function totalFromContentRange(v: string | null): number | null {
  const m = v ? /\/(\d+)\s*$/.exec(v) : null;
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** One byte range; null when the server ignores ranges (never reads a whole file). */
async function readRange(uri: string, from: number, to: number, headers?: Record<string, string>): Promise<{ bytes: Uint8Array; total: number | null } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(uri, { headers: { ...headers, Range: `bytes=${from}-${to}` }, signal: ctl.signal });
    if (r.status !== 206) {
      ctl.abort();
      return null;
    }
    const bytes = new Uint8Array(await r.arrayBuffer());
    return bytes.byteLength === to - from + 1 ? { bytes, total: totalFromContentRange(r.headers.get('content-range')) } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** `{ videoHash, videoSize }` of the file at `uri`, or null (no range support, too small, error). */
export async function fetchVideoHash(uri: string, headers?: Record<string, string>, sizeHint?: number): Promise<{ videoHash: string; videoSize: number } | null> {
  if (!/^https?:\/\//i.test(uri)) return null;
  const head = await readRange(uri, 0, CHUNK - 1, headers);
  const size = head?.total ?? sizeHint ?? null;
  if (!head || !size || size < CHUNK * 2) return null;
  const tail = await readRange(uri, size - CHUNK, size - 1, headers);
  if (!tail) return null;
  return { videoHash: openSubtitlesHash(size, head.bytes, tail.bytes), videoSize: size };
}
