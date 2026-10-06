// Network for Paperback extensions: every request a sandbox asks for goes through here.
// Policy: http(s) only, no loopback / link-local hosts, bounded headers and bodies, per-source
// cookie jar (never the app's cookies), per-source rate limit and concurrency, timeouts,
// bounded response size. The transport (`RawFetch`) is injected: RN fetch in the app, Node fetch in tests.
import { base64ToBytes, bytesToBase64, utf8DecodeStrict } from './b64';
import { isChallengeResponse } from './cloudflare-core';
import type { HttpCookie, HttpRequest, HttpResponse } from './runtime/protocol';

export const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_HEADERS = 40;
const DEFAULT_TIMEOUT = 20_000;
const MAX_TIMEOUT = 45_000;
const MAX_RPS = 8;
const MAX_CONCURRENT = 4;
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

// ---------- URL policy ----------

export type ParsedUrl = { protocol: 'http' | 'https'; host: string; port?: string; path: string };

/** Strict http(s) URL parser (RN's URL polyfill is incomplete). */
export function parseHttpUrl(url: unknown): ParsedUrl | undefined {
  if (typeof url !== 'string' || url.length > 4096) return undefined;
  const m = /^(https?):\/\/(?:[^/?#@\s]*@)?(\[[0-9a-f:.]+\]|[^/?#:\s[\]]+)(?::(\d{1,5}))?([/?#][^\s]*)?$/i.exec(url.trim());
  if (!m) return undefined;
  return { protocol: m[1].toLowerCase() as 'http' | 'https', host: m[2].toLowerCase(), port: m[3], path: m[4] ?? '/' };
}

/**
 * IPv4 literal as the OS resolvers read it (inet_aton / WHATWG URL): 1 to 4 parts, each decimal,
 * `0x` hex or leading-zero octal (`2130706433`, `0x7f.1`, `0177.0.0.1` are all 127.0.0.1).
 * `undefined` = not an IPv4 literal; `null` = looks numeric but is malformed.
 */
export function parseIPv4(host: string): number | null | undefined {
  const parts = host.split('.');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  if (!/^(0x[0-9a-f]*|\d+)$/i.test(parts[parts.length - 1] ?? '')) return undefined;
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p.slice(1), 8);
    else if (/^\d+$/.test(p) && !/^0\d/.test(p)) n = Number(p);
    else return null;
    if (!Number.isSafeInteger(n)) return null;
    nums.push(n);
  }
  const last = nums.pop()!;
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) return null;
  return nums.reduce((acc, n, i) => acc + n * 256 ** (3 - i), 0) + last;
}

/** IPv6 literal (without brackets) → 16 bytes, `undefined` when malformed. */
export function parseIPv6(host: string): number[] | undefined {
  if (!/^[0-9a-f:.]+$/i.test(host) || !host.includes(':')) return undefined;
  const halves = host.split('::');
  if (halves.length > 2) return undefined;
  const words = (s: string): number[] | undefined => {
    if (s === '') return [];
    const out: number[] = [];
    const groups = s.split(':');
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (i === groups.length - 1 && g.includes('.')) {
        const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(g) ? g.split('.').map(Number) : undefined;
        if (!v4 || v4.some((n) => n > 255)) return undefined;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else if (/^[0-9a-f]{1,4}$/i.test(g)) out.push(parseInt(g, 16));
      else return undefined;
    }
    return out;
  };
  const head = words(halves[0]);
  const tail = halves.length === 2 ? words(halves[1]) : [];
  if (!head || !tail) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const all = [...head, ...new Array<number>(missing).fill(0), ...tail];
  return all.flatMap((w) => [w >> 8, w & 0xff]);
}

const blockedV4 = (ip: number) => {
  const a = Math.floor(ip / 2 ** 24);
  const b = Math.floor(ip / 2 ** 16) & 0xff;
  return a === 0 || a === 127 || (a === 169 && b === 254);
};

/**
 * Loopback, unspecified and link-local targets are refused (a source has no business there), in
 * every spelling the OS accepts (canonical IPv4/IPv6 values, not text). LAN is allowed (self-hosted
 * servers, `nas.local`): the app's own servers (torrent stream, Metro) bind 127.0.0.1 only.
 * Residual risk: a public name resolving to 127.0.0.1 (DNS rebinding) is not caught here, the
 * app cannot resolve names before the native stack does.
 */
export function isBlockedHost(host: string) {
  const h = host.toLowerCase().replace(/\.+$/, '');
  if (/^\[.*\]$/.test(h)) {
    const b = parseIPv6(h.slice(1, -1));
    if (!b) return true;
    const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
    if (zero(0, 16) || (zero(0, 15) && b[15] === 1)) return true; // :: and ::1
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10
    const v4 = ((b[12] << 24) >>> 0) + (b[13] << 16) + (b[14] << 8) + b[15];
    // Embedded IPv4: compatible (::a.b.c.d), mapped (::ffff:a.b.c.d), translated (::ffff:0:a.b.c.d), NAT64 (64:ff9b::a.b.c.d).
    const embeds =
      zero(0, 12) ||
      (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) ||
      (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && zero(10, 12)) ||
      (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12));
    return embeds && blockedV4(v4);
  }
  if (!h || !/^[a-z0-9._-]+$/.test(h)) return true; // percent-encoded or odd hosts: not a hostname
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const v4 = parseIPv4(h);
  if (v4 === null) return true;
  return v4 !== undefined && blockedV4(v4);
}

/**
 * Percent-encodes what is not allowed raw in a URL (spaces, non-ASCII, `|{}"<>\^\``), as the
 * Paperback app does: many sources build search URLs by plain concatenation.
 */
export function escapeUrl(url: string): string {
  return url.trim().replace(/[^\x21-\x7e]|["<>\\^`{|}]/g, (c) => encodeURIComponent(c));
}

export function checkUrl(url: unknown): ParsedUrl {
  const p = parseHttpUrl(typeof url === 'string' ? escapeUrl(url) : url);
  if (!p) throw new Error('URL refusée (http/https uniquement)');
  if (isBlockedHost(p.host)) throw new Error('Hôte refusé');
  return p;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
/** Headers the app sets itself or that make no sense for a source. */
const FORBIDDEN = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'keep-alive', 'te', 'trailer', 'proxy-authorization', 'proxy-connection']);

export function cleanHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h || typeof h !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(h)) {
    if (n >= MAX_HEADERS) break;
    if (!TOKEN.test(k) || FORBIDDEN.has(k.toLowerCase()) || v == null) continue;
    const value = String(v).replace(/[\r\n\0]/g, ' ').slice(0, 8192);
    out[k] = value;
    n++;
  }
  return out;
}

// ---------- cookies ----------

type StoredCookie = { name: string; value: string; domain: string; hostOnly: boolean; path: string; expires?: number; secure: boolean };

/** Splits a combined `Set-Cookie` value (RN joins several with ", ") without breaking on `Expires=Wed, 21 Oct…`. */
export function splitSetCookie(v: string): string[] {
  return v.split(/,(?=\s*[^;,=\s]+=)/).map((s) => s.trim()).filter(Boolean);
}

export class CookieJar {
  private list: StoredCookie[] = [];
  private onChange?: () => void;
  constructor(saved?: unknown, onChange?: () => void) {
    this.onChange = onChange;
    if (Array.isArray(saved)) this.list = saved.filter((c) => c && typeof c.name === 'string' && typeof c.domain === 'string').slice(0, 300);
  }
  toJSON() {
    return this.list;
  }
  /**
   * Adds a cookie that didn't come from a `Set-Cookie` of this jar's requests (copied from the
   * Cloudflare verification WebView). Same replacement rule as `set`: name + domain + path.
   */
  put(c: { name: string; value: string; domain: string; hostOnly?: boolean; path?: string; expires?: number; secure?: boolean }) {
    if (!c.name || c.name.length > 256 || c.value.length > 4096 || /[;\r\n]/.test(c.name + c.value)) return;
    const domain = c.domain.replace(/^\./, '').toLowerCase();
    if (!domain || isBlockedHost(domain)) return;
    const path = c.path && c.path.startsWith('/') ? c.path : '/';
    this.list = this.list.filter((x) => !(x.name === c.name && x.domain === domain && x.path === path));
    if (!c.expires || c.expires > Date.now()) {
      this.list.push({ name: c.name, value: c.value, domain, hostOnly: c.hostOnly ?? !c.domain.startsWith('.'), path, expires: c.expires, secure: !!c.secure });
    }
    if (this.list.length > 300) this.list.splice(0, this.list.length - 300);
    this.onChange?.();
  }
  private alive(now = Date.now()) {
    this.list = this.list.filter((c) => !c.expires || c.expires > now);
    return this.list;
  }
  set(url: ParsedUrl, header: string): HttpCookie | undefined {
    const [pair, ...attrs] = header.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) return undefined;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name || name.length > 256 || value.length > 4096) return undefined;
    let domain = url.host;
    let hostOnly = true;
    let path = '/';
    let expires: number | undefined;
    let secure = false;
    for (const a of attrs) {
      const i = a.indexOf('=');
      const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
      const v = i < 0 ? '' : a.slice(i + 1).trim();
      if (k === 'domain' && v) {
        const d = v.replace(/^\./, '').toLowerCase();
        // A cookie may only widen to a parent domain of the responding host.
        if (url.host === d || url.host.endsWith(`.${d}`)) {
          domain = d;
          hostOnly = false;
        } else return undefined;
      } else if (k === 'path' && v.startsWith('/')) path = v;
      else if (k === 'max-age' && /^-?\d+$/.test(v)) expires = Date.now() + Number(v) * 1000;
      else if (k === 'expires' && expires === undefined) {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) expires = t;
      } else if (k === 'secure') secure = true;
    }
    this.list = this.list.filter((c) => !(c.name === name && c.domain === domain && c.path === path));
    const cookie: StoredCookie = { name, value, domain, hostOnly, path, expires, secure };
    if (!expires || expires > Date.now()) this.list.push(cookie);
    if (this.list.length > 300) this.list.splice(0, this.list.length - 300);
    this.onChange?.();
    return { name, value, domain, path, expires: expires ? new Date(expires).toISOString() : undefined };
  }
  header(url: ParsedUrl): string {
    const reqPath = url.path.split(/[?#]/)[0] || '/';
    return this.alive()
      .filter((c) => (c.hostOnly ? url.host === c.domain : url.host === c.domain || url.host.endsWith(`.${c.domain}`)))
      .filter((c) => reqPath === c.path || reqPath.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`))
      .filter((c) => !c.secure || url.protocol === 'https')
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }
}

// ---------- rate limiting ----------

class Limiter {
  private last = 0;
  private active = 0;
  private waiters: (() => void)[] = [];
  async run<T>(rps: number, fn: () => Promise<T>): Promise<T> {
    while (this.active >= MAX_CONCURRENT) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      const gap = 1000 / Math.max(0.2, Math.min(MAX_RPS, rps));
      const wait = this.last + gap - Date.now();
      this.last = Math.max(Date.now(), this.last + gap);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

// ---------- requests ----------

export type RawResponse = { url: string; status: number; headers: Record<string, string>; setCookies: string[]; body: Uint8Array };
/**
 * Transport contract: performs ONE hop (no redirect following: a 3xx comes back as is, with its
 * `location` header) so that `createNet` checks every redirect target against the URL policy, and
 * stops receiving as soon as the body exceeds `maxBytes` (`readCapped`).
 */
export type RawFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; signal: AbortSignal; maxBytes: number; redirect: 'manual' },
) => Promise<RawResponse>;

export class TooLargeError extends Error {
  constructor() {
    super('Réponse trop volumineuse');
  }
}

/**
 * Reads a body stream while counting: past `maxBytes` the stream is cancelled (the native request
 * is torn down) and `TooLargeError` thrown, so a huge chunked response is never buffered whole.
 */
export async function readCapped(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> }, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('too large').catch(() => {});
      throw new TooLargeError();
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Resolves a `Location` header against the URL that returned it (absolute, `//host`, `/path`, relative). */
export function resolveLocation(base: string, location: string): string | undefined {
  const loc = escapeUrl(location);
  if (!loc) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(loc)) return loc;
  const b = /^(https?:)\/\/([^/?#]*)([^?#]*)/i.exec(base);
  if (!b) return undefined;
  if (loc.startsWith('//')) return `${b[1]}${loc}`;
  if (loc.startsWith('/')) return `${b[1]}//${b[2]}${loc}`;
  if (loc.startsWith('?') || loc.startsWith('#')) return `${b[1]}//${b[2]}${b[3] || '/'}${loc}`;
  const dir = (b[3] || '/').replace(/[^/]*$/, '');
  return `${b[1]}//${b[2]}${dir}${loc}`;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

const origin = (p: ParsedUrl) => `${p.protocol}://${p.host}:${p.port ?? ''}`;

export type NetOptions = {
  jar: (sourceKey: string) => CookieJar;
  maxBytes?: number;
  /**
   * User-Agent to force for a host (a site cleared by a Cloudflare check only accepts the
   * clearance cookie with the browser's User-Agent). `undefined` = keep the source's own.
   */
  userAgentFor?: (host: string) => string | undefined;
  /** A response was a Cloudflare challenge (status / headers / page). */
  onChallenge?: (sourceKey: string, url: string) => void;
};

/** First bytes of an error page, as text, for challenge detection (no full decode of big bodies). */
function head(body: Uint8Array, max = 32 * 1024): string {
  const n = Math.min(body.length, max);
  let s = '';
  for (let i = 0; i < n; i += 0x2000) s += String.fromCharCode.apply(null, Array.from(body.subarray(i, Math.min(n, i + 0x2000))));
  return s;
}

export function createNet(rawFetch: RawFetch, opts: NetOptions) {
  const limiters = new Map<string, Limiter>();
  const limiter = (k: string) => limiters.get(k) ?? (limiters.set(k, new Limiter()), limiters.get(k)!);
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;

  async function request(sourceKey: string, req: HttpRequest): Promise<HttpResponse> {
    if (!req || typeof req !== 'object') throw new Error('Requête invalide');
    const first = checkUrl(req.url);
    let method = String(req.method ?? 'GET').toUpperCase();
    if (!METHODS.has(method)) throw new Error('Méthode refusée');
    const baseHeaders = cleanHeaders(req.headers);
    let body: string | Uint8Array | undefined;
    if (typeof req.body64 === 'string' && req.body64 && method !== 'GET' && method !== 'HEAD') {
      if (req.body64.length > (MAX_BODY_BYTES * 4) / 3 + 4) throw new Error('Corps de requête trop gros');
      const bytes = base64ToBytes(req.body64);
      body = utf8DecodeStrict(bytes) ?? bytes;
    }
    if (!Object.keys(baseHeaders).some((k) => k.toLowerCase() === 'user-agent')) baseHeaders['User-Agent'] = DEFAULT_USER_AGENT;
    const jar = opts.jar(sourceKey);
    const timeout = Math.min(MAX_TIMEOUT, Math.max(3_000, Number(req.timeoutMs) || DEFAULT_TIMEOUT));
    const rps = Number(req.rps) > 0 ? Number(req.rps) : 4;
    let bodyDropped = false;

    /** Headers for one hop: the jar's cookies for that URL; the source's own Cookie/Authorization stay on the first origin. */
    const headersFor = (target: ParsedUrl) => {
      const sameOrigin = origin(target) === origin(first);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(baseHeaders)) {
        const lk = k.toLowerCase();
        if (!sameOrigin && (lk === 'cookie' || lk === 'authorization')) continue;
        headers[k] = v;
      }
      const jarCookies = jar.header(target);
      if (jarCookies) {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie');
        headers[key ?? 'Cookie'] = key ? `${jarCookies}; ${headers[key]}` : jarCookies;
      }
      if (bodyDropped) for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k];
      const ua = opts.userAgentFor?.(target.host);
      if (ua) {
        for (const k of Object.keys(headers)) if (k.toLowerCase() === 'user-agent') delete headers[k];
        headers['User-Agent'] = ua;
      }
      return headers;
    };

    return limiter(sourceKey).run(rps, async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        let url = escapeUrl(req.url);
        let target = first;
        const cookies: HttpCookie[] = [];
        for (let hop = 0; ; hop++) {
          let raw: RawResponse;
          try {
            raw = await rawFetch(url, { method, headers: headersFor(target), body, signal: ctrl.signal, maxBytes, redirect: 'manual' });
          } catch (e) {
            if (e instanceof TooLargeError) throw e;
            throw new Error(ctrl.signal.aborted ? 'Délai réseau dépassé' : e instanceof Error ? e.message : 'Erreur réseau');
          }
          // Defence in depth: a transport that followed a redirect anyway must not deliver a refused host.
          const landed = parseHttpUrl(raw.url);
          if (landed && isBlockedHost(landed.host)) throw new Error('Hôte refusé (redirection)');
          if (raw.body.length > maxBytes) throw new TooLargeError();
          const at = landed ?? target;
          for (const sc of raw.setCookies) {
            const c = jar.set(at, sc);
            if (c) cookies.push(c);
          }
          const headersOut: Record<string, string> = {};
          for (const [k, v] of Object.entries(raw.headers)) if (k.toLowerCase() !== 'set-cookie') headersOut[k.toLowerCase()] = String(v).slice(0, 8192);
          const location = REDIRECTS.has(raw.status) ? headersOut.location : undefined;
          const next = location ? resolveLocation(landed ? raw.url : url, location) : undefined;
          if (!next) {
            const challenge = isChallengeResponse({ status: raw.status, headers: headersOut, body: raw.status >= 400 ? head(raw.body) : undefined });
            if (challenge) opts.onChallenge?.(sourceKey, landed ? raw.url : url);
            return {
              ...(challenge ? { challenge: true } : {}),
              url: landed ? raw.url : url,
              status: raw.status,
              headers: headersOut,
              cookies,
              mimeType: headersOut['content-type']?.split(';')[0]?.trim() || undefined,
              body64: bytesToBase64(raw.body),
            };
          }
          if (hop >= MAX_REDIRECTS) throw new Error('Trop de redirections');
          const p = parseHttpUrl(next);
          if (!p) throw new Error('URL refusée (redirection)');
          if (isBlockedHost(p.host)) throw new Error('Hôte refusé (redirection)');
          if (raw.status === 303 ? method !== 'HEAD' : (raw.status === 301 || raw.status === 302) && method === 'POST') {
            method = 'GET';
            bodyDropped ||= body !== undefined;
            body = undefined;
          }
          url = next;
          target = p;
        }
      } finally {
        clearTimeout(timer);
      }
    });
  }

  return { request };
}
