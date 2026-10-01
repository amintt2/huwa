// Hosted players ("lecteurs web"): some addons answer with the page of a video host (an embed
// page, like the several players offered by streaming sites) instead of a media file, either as
// `externalUrl` or as a `url` that is not a video. Huwa opens those pages in its web player
// (src/components/player/WebPlayer.tsx). Nothing here scrapes a site: only what the installed
// addon returned is classified.
import { useEffect, useSyncExternalStore } from 'react';

import type { StreamItem } from './protocol';

/** `direct` = a media file / playlist the native player opens; `page` = an HTML player page. */
export type MediaGuess = 'direct' | 'page' | 'unknown';

const MEDIA_EXT = /\.(m3u8|mp4|m4v|mkv|webm|mov|avi|ts|mpd|mp3|m4a|flac)$/i;
const PAGE_EXT = /\.(html?|php|aspx?|jsp)$/i;
// Path shapes of embed players (`/embed/…`, `/e/…`, `/player/…`).
const EMBED_PATH = /\/(embed|embed-[^/]+|e|player|iframe)(\/|$)/i;

const pathOf = (url: string) => {
  const m = /^[a-z]+:\/\/[^/?#]*([^?#]*)/i.exec(url);
  return m ? decodeSafe(m[1]) : '';
};
function decodeSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** From the URL alone (and the file name the addon may give): extension, then embed-like paths. */
export function guessFromUrl(url: string, filename?: string): MediaGuess {
  const path = pathOf(url);
  if (MEDIA_EXT.test(path) || (filename && MEDIA_EXT.test(filename))) return 'direct';
  // A media extension hidden in the query (`…/get?file=video.mp4`, `…/stream?type=.m3u8`).
  if (/[?&][^=]+=[^&]*\.(m3u8|mp4|mkv|webm|mov)(&|$)/i.test(url)) return 'direct';
  if (PAGE_EXT.test(path) || EMBED_PATH.test(path)) return 'page';
  return 'unknown';
}

/** From a `Content-Type` header. */
export function guessFromContentType(ct: string | null | undefined): MediaGuess {
  const t = (ct ?? '').split(';')[0].trim().toLowerCase();
  if (!t) return 'unknown';
  if (t.startsWith('video/') || t.startsWith('audio/')) return 'direct';
  if (/^application\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl|dash\+xml|octet-stream|mp4)$/.test(t)) return 'direct';
  if (t === 'text/html' || t === 'application/xhtml+xml') return 'page';
  return 'unknown';
}

const isHttp = (u?: string): u is string => !!u && /^https?:\/\//i.test(u);

/**
 * Page to open in the web player for this stream, or null (direct link, torrent, YouTube…).
 * `probed` holds what `probeUrl` learned about `url`s the extension did not settle.
 */
export function webPlayerUrl(s: StreamItem, probed?: Record<string, MediaGuess>): string | null {
  if (isHttp(s.url)) {
    const g = probed?.[s.url] ?? guessFromUrl(s.url, s.behaviorHints?.filename);
    return g === 'page' ? s.url : null;
  }
  if (!s.url && !s.infoHash && !s.ytId && isHttp(s.externalUrl)) return s.externalUrl;
  return null;
}

/**
 * Hosted player auto mode may open without asking: a `url` that turned out to be a page, or an
 * `externalUrl` shaped like an embed player. Other external links (a project page, a donation
 * link…) are only listed, never auto-played.
 */
export function autoWebPlayerUrl(s: StreamItem, probed?: Record<string, MediaGuess>): string | null {
  const u = webPlayerUrl(s, probed);
  if (!u) return null;
  return isHttp(s.url) || EMBED_PATH.test(pathOf(u)) ? u : null;
}

/** `url` whose nature is not settled by its shape (needs `probeUrl`). */
export const needsProbe = (s: StreamItem) =>
  isHttp(s.url) && guessFromUrl(s.url, s.behaviorHints?.filename) === 'unknown' && !s.behaviorHints?.videoSize && !s.behaviorHints?.videoHash;

/** Host shown in the menu ("vidhost.example"), without `www.`. */
export function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(url);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : url;
}

/**
 * Registrable domain, approximately (last two labels, three under `co.uk`-like suffixes): the
 * web player keeps its main frame on it, so a page cannot redirect to an ad site.
 */
export function siteOf(url: string): string {
  const host = hostOf(url);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || !host.includes('.')) return host;
  const parts = host.split('.');
  const n = parts.length >= 3 && /^(co|com|net|org|gov|edu|ac)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join('.');
}

// ---------- probing (HEAD, then a 1-byte GET) with a shared cache ----------

type Fetch = typeof fetch;
const probed: Record<string, MediaGuess> = {};
const inflight = new Map<string, Promise<MediaGuess>>();
const listeners = new Set<() => void>();
let snapshot: Record<string, MediaGuess> = {};

async function headers(f: Fetch, url: string, init: RequestInit, timeoutMs: number): Promise<MediaGuess> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Raced as well as aborted: some fetch implementations ignore the signal.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([f(url, { ...init, signal: ctrl.signal }), timeout]);
    const g = res.ok || res.status === 206 ? guessFromContentType(res.headers.get('content-type')) : 'unknown';
    ctrl.abort(); // headers are enough: drop the body
    return g;
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What an extension-less `url` serves, from its `Content-Type` (HEAD, or a GET of its first byte
 * when HEAD is refused). Cached per URL; `unknown` is treated as direct (the native player tries).
 */
export function probeUrl(url: string, reqHeaders?: Record<string, string>, f: Fetch = fetch, timeoutMs = 4000): Promise<MediaGuess> {
  if (probed[url]) return Promise.resolve(probed[url]);
  let p = inflight.get(url);
  if (!p) {
    p = (async () => {
      let g = await headers(f, url, { method: 'HEAD', headers: reqHeaders }, timeoutMs);
      if (g === 'unknown') g = await headers(f, url, { method: 'GET', headers: { ...reqHeaders, Range: 'bytes=0-0' } }, timeoutMs);
      probed[url] = g;
      inflight.delete(url);
      snapshot = { ...probed };
      listeners.forEach((l) => l());
      return g;
    })();
    inflight.set(url, p);
  }
  return p;
}

/** Test helper. */
export function clearProbeCache() {
  for (const k of Object.keys(probed)) delete probed[k];
  inflight.clear();
  snapshot = {};
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Probes the streams whose `url` is ambiguous; returns every result known so far. */
export function useProbedUrls(streams: StreamItem[], enabled = true): Record<string, MediaGuess> {
  const todo = enabled ? streams.filter(needsProbe).slice(0, 24) : [];
  const key = todo.map((s) => s.url).join('\n');
  useEffect(() => {
    for (const s of todo) probeUrl(s.url!, s.behaviorHints?.proxyHeaders?.request).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
