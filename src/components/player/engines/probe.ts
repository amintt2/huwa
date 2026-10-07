// Source probing for the engine policy: URL extension, then one `Range: bytes=0-4095` request
// (Content-Type + magic bytes + MP4 sample entries). An MP4 whose `moov` does not fit in those
// bytes (at the end of the file, or a long one) gets a second Range request for it: its audio
// sample entries tell DTS / TrueHD / MP3, which AVPlayer drops silently. Results are cached per URL.
import { engineHashOf } from '@/torrent/stream-input';

import { conclusiveWithoutSniff, containerFromMime, containerFromUrl, mp4Codecs, mp4MoovRange, sniff, type Probe } from './policy';

const PROBE_BYTES = 4096;
const TIMEOUT_MS = 3500;
/** The moov read shares the probe budget, with at least this much of its own. */
const MOOV_MIN_MS = 1500;
const MAX_CACHE = 200;

const cache = new Map<string, Probe>();

function remember(url: string, p: Probe): Probe {
  cache.delete(url);
  cache.set(url, p);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  return p;
}

/**
 * Reads a local file (`file://`, downloaded episode) for `probeSource`: registered by
 * local-probe.ts (expo-file-system), absent in unit tests.
 */
let localSniffer: ((url: string) => Probe | null) | null = null;
export function setLocalSniffer(f: ((url: string) => Probe | null) | null) {
  localSniffer = f;
}

export function cachedProbe(url: string): Probe | undefined {
  return cache.get(url);
}

export type Head = { status: number; contentType: string | null; bytes: Uint8Array | null };

/**
 * XMLHttpRequest rather than fetch: RN's fetch only resolves once the whole body is read, so a
 * server that ignores `Range` would make us download the entire video. Here the request is
 * aborted as soon as the headers show a non-206 answer.
 */
export function readHead(url: string, headers: Record<string, string> | undefined, start = 0, end = PROBE_BYTES - 1, timeoutMs = TIMEOUT_MS): Promise<Head> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let done = false;
    const finish = (h: Head) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(h);
    };
    const timer = setTimeout(() => {
      xhr.abort();
      finish({ status: 0, contentType: null, bytes: null });
    }, timeoutMs);
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    for (const [k, v] of Object.entries(headers ?? {})) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader('Range', `bytes=${start}-${end}`);
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 2 && xhr.status !== 206) {
        // Full-body answer (or error): keep the Content-Type, drop the body.
        const contentType = xhr.getResponseHeader('Content-Type');
        const status = xhr.status;
        xhr.abort();
        finish({ status, contentType, bytes: null });
      }
    };
    xhr.onload = () => {
      const buf = xhr.response as ArrayBuffer | null;
      finish({ status: xhr.status, contentType: xhr.getResponseHeader('Content-Type'), bytes: buf ? new Uint8Array(buf) : null });
    };
    xhr.onerror = () => finish({ status: 0, contentType: null, bytes: null });
    xhr.send();
  });
}

/**
 * What can be known without a request: the URL extension, and whether the built-in torrent engine
 * serves it. Its URLs carry the file's extension once the torrent metadata is known; without it, a
 * sniff would wait for the torrent's first piece (see `decideEngine`), so none is made.
 */
export function probeWithoutRequest(url: string): Probe | null {
  const p = fromUrl(url);
  return conclusiveWithoutSniff(p) || (p.torrent && p.container === 'unknown') ? p : null;
}

function fromUrl(url: string): Probe {
  const torrent = !!engineHashOf(url);
  return { container: containerFromUrl(url), codecs: [], via: 'ext', ...(torrent ? { torrent } : null) };
}

/** Adds the codecs of a `moov` the first bytes did not hold (whatever was learned is kept on failure). */
async function withMoov(url: string, headers: Record<string, string> | undefined, headBytes: Uint8Array, s: Probe, t0: number): Promise<Probe> {
  const range = mp4MoovRange(headBytes);
  if (!range) return s;
  const left = Math.max(MOOV_MIN_MS, TIMEOUT_MS - (Date.now() - t0));
  const r = await readHead(url, headers, range.start, range.end, left);
  if (r.status !== 206 || !r.bytes?.length) return s;
  const more = mp4Codecs(r.bytes);
  return more.length ? { ...s, codecs: [...new Set([...s.codecs, ...more])] } : s;
}

/** Never throws; `{ container: 'unknown' }` when nothing could be learned. */
export async function probeSource(url: string, headers?: Record<string, string>): Promise<Probe> {
  const hit = cache.get(url);
  if (hit) return hit;

  const quick = probeWithoutRequest(url);
  if (quick) return remember(url, quick);
  const fromExt = fromUrl(url);
  const torrent = fromExt.torrent;
  // Downloaded MP4: its sample entries tell DTS / Hi10P… as for a remote file.
  if (/^file:/i.test(url) && localSniffer) {
    const p = localSniffer(url);
    if (p && p.container !== 'unknown') return remember(url, p);
  }
  if (!/^https?:/i.test(url)) return fromExt;

  const t0 = Date.now();
  const head = await readHead(url, headers);
  if (head.bytes && head.bytes.length) {
    let s = sniff(head.bytes);
    if (s.container === 'mp4' || s.container === 'mov') s = await withMoov(url, headers, head.bytes, s, t0);
    if (s.container !== 'unknown') return remember(url, torrent ? { ...s, torrent } : s);
  }
  const mime = containerFromMime(head.contentType);
  if (mime !== 'unknown') return remember(url, { container: mime, codecs: [], via: 'mime', ...(torrent ? { torrent } : null) });
  // Unreachable/unknown: not cached, the next attempt may do better. A torrent (MP4 whose first
  // piece did not come within the sniff budget) stays flagged: mpv, not a 15 s AVPlayer attempt.
  return torrent ? { container: 'unknown', codecs: [], via: 'none', torrent } : fromExt.container !== 'unknown' ? fromExt : { container: 'unknown', codecs: [], via: 'none' };
}
