// HTTP read-ahead proxy, player side (pure: the native binding registers itself, see
// src/torrent/http-proxy.ts). HTTP sources that mpv plays go through a loopback proxy in the Rust
// engine (native/huwa-torrent-core/src/http_proxy.rs): head, tail (MKV Cues / MP4 moov) and, for a
// resume, the target are fetched in parallel at open instead of one after the other by mpv;
// connections are reused, a stuck range is asked again. Measured in native/huwa-torrent-core/bench
// (README, "HTTP through the read-ahead proxy").
//
// Every failure falls back to the original URL: no binding (Expo Go, build without HUWA_TORRENT),
// setting off, a server ignoring Range (`fallback`), a slow bridge.

export type ProxyPrefetch = {
  /** Resume position (s). */
  startAt?: number;
  /** Video duration (s), when known (saved progress, the playing file): places the target. */
  duration?: number;
  /** File size from the addon (`behaviorHints.videoSize`): the target leaves at once. */
  size?: number;
  /** Container when known (`mkv`, `mp4`…): sizes the tail. */
  container?: string;
};

export type ProxyStatus = {
  length: number | null;
  noRange: boolean;
  /** Upstream refusal (`status` ≥ 400) or network failure (`status` 0). */
  error: { status: number; message: string } | null;
  bytesFetched: number;
  ttfbMs: number | null;
};

export type ProxyHandle = {
  id: number;
  /** `http://127.0.0.1:<port>/http/<id>[.ext]`: what mpv opens. */
  url: string;
  /** Starts the head / tail / target fetches (a session opened for a header sniff has none yet). */
  prefetch(p: ProxyPrefetch): void;
  status(): Promise<ProxyStatus | null>;
  /** Stops every download of this session (idempotent). */
  release(): void;
};

export type HttpProxyPort = {
  /** Linked, switched on, and allowed on this platform. */
  enabled(): boolean;
  /** `prefetch` null: nothing is fetched until a request comes (header sniffs). */
  open(url: string, headers: Record<string, string> | undefined, prefetch: ProxyPrefetch | null): Promise<ProxyHandle | null>;
};

let port: HttpProxyPort | null = null;

/** Registered by the app (src/torrent/http-proxy.ts); absent in unit tests and Expo Go. */
export function setHttpProxy(p: HttpProxyPort | null) {
  port = p;
}

export function httpProxy(): HttpProxyPort | null {
  try {
    return port && port.enabled() ? port : null;
  } catch {
    return null;
  }
}

/**
 * Remote HTTP(S) file links only: not the app's own loopback servers (torrent engine, the proxy
 * itself), not playlists (HLS / DASH: mpv fetches their segments by URL), not `file:`.
 */
export function isProxiable(url: string, container?: string | null): boolean {
  if (container === 'hls' || container === 'dash') return false;
  const m = /^https?:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(url);
  if (!m) return false;
  const host = m[1].toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '0.0.0.0' || /^127\./.test(host)) return false;
  const path = url.split(/[?#]/)[0];
  return !/\.(m3u8?|mpd)$/i.test(path);
}

/** Message for a source the proxy saw refused / unreachable (shown, then the source is left). */
export function describeProxyError(s: ProxyStatus | null): string | null {
  const e = s?.error;
  if (!e) return null;
  if (e.status === 403 || e.status === 401 || e.status === 410) return `Lien refusé ou expiré (HTTP ${e.status})`;
  if (e.status === 404) return 'Fichier introuvable sur le serveur (HTTP 404)';
  if (e.status >= 400) return `Le serveur refuse la lecture (HTTP ${e.status})`;
  return 'Serveur injoignable';
}
