// Network for Paperback extensions: every request a sandbox asks for goes through here.
// Policy: http(s) only, no loopback / link-local hosts, bounded headers and bodies, per-source
// cookie jar (never the app's cookies), per-source rate limit and concurrency, timeouts,
// bounded response size. The transport (`RawFetch`) is injected: RN fetch in the app, Node fetch in tests.
import { base64ToBytes, bytesToBase64, utf8DecodeStrict } from './b64';
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
  const m = /^(https?):\/\/(?:[^/?#@\s]*@)?(\[[0-9a-f:.]+\]|[^/?#:\s]+)(?::(\d{1,5}))?([/?#][^\s]*)?$/i.exec(url.trim());
  if (!m) return undefined;
  return { protocol: m[1].toLowerCase() as 'http' | 'https', host: m[2].toLowerCase(), port: m[3], path: m[4] ?? '/' };
}

/** Loopback and link-local targets are refused (a source has no business there). LAN is allowed (self-hosted servers). */
export function isBlockedHost(host: string) {
  const h = host.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (/^127\./.test(h) || /^169\.254\./.test(h) || /^0\./.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(h) || /^::ffff:(127|169\.254)\./i.test(h)) return true;
  return false;
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
export type RawFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; signal: AbortSignal; maxBytes: number },
) => Promise<RawResponse>;

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export function createNet(rawFetch: RawFetch, opts: { jar: (sourceKey: string) => CookieJar; maxBytes?: number }) {
  const limiters = new Map<string, Limiter>();
  const limiter = (k: string) => limiters.get(k) ?? (limiters.set(k, new Limiter()), limiters.get(k)!);

  async function request(sourceKey: string, req: HttpRequest): Promise<HttpResponse> {
    if (!req || typeof req !== 'object') throw new Error('Requête invalide');
    const target = checkUrl(req.url);
    const method = String(req.method ?? 'GET').toUpperCase();
    if (!METHODS.has(method)) throw new Error('Méthode refusée');
    const headers = cleanHeaders(req.headers);
    let body: string | Uint8Array | undefined;
    if (typeof req.body64 === 'string' && req.body64 && method !== 'GET' && method !== 'HEAD') {
      if (req.body64.length > (MAX_BODY_BYTES * 4) / 3 + 4) throw new Error('Corps de requête trop gros');
      const bytes = base64ToBytes(req.body64);
      body = utf8DecodeStrict(bytes) ?? bytes;
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) headers['User-Agent'] = DEFAULT_USER_AGENT;
    const jar = opts.jar(sourceKey);
    const jarCookies = jar.header(target);
    if (jarCookies) {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie');
      headers[key ?? 'Cookie'] = key ? `${jarCookies}; ${headers[key]}` : jarCookies;
    }
    const timeout = Math.min(MAX_TIMEOUT, Math.max(3_000, Number(req.timeoutMs) || DEFAULT_TIMEOUT));
    const rps = Number(req.rps) > 0 ? Number(req.rps) : 4;

    return limiter(sourceKey).run(rps, async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      let raw: RawResponse;
      try {
        raw = await rawFetch(escapeUrl(req.url), { method, headers, body, signal: ctrl.signal, maxBytes: opts.maxBytes ?? MAX_RESPONSE_BYTES });
      } catch (e) {
        throw new Error(ctrl.signal.aborted ? 'Délai réseau dépassé' : e instanceof Error ? e.message : 'Erreur réseau');
      } finally {
        clearTimeout(timer);
      }
      if (raw.body.length > (opts.maxBytes ?? MAX_RESPONSE_BYTES)) throw new Error('Réponse trop volumineuse');
      const finalUrl = parseHttpUrl(raw.url) ? raw.url : escapeUrl(req.url);
      const cookies: HttpCookie[] = [];
      const at = parseHttpUrl(finalUrl) ?? target;
      for (const sc of raw.setCookies) {
        const c = jar.set(at, sc);
        if (c) cookies.push(c);
      }
      const headersOut: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.headers)) if (k.toLowerCase() !== 'set-cookie') headersOut[k.toLowerCase()] = String(v).slice(0, 8192);
      return {
        url: finalUrl,
        status: raw.status,
        headers: headersOut,
        cookies,
        mimeType: headersOut['content-type']?.split(';')[0]?.trim() || undefined,
        body64: bytesToBase64(raw.body),
      };
    });
  }

  return { request };
}
