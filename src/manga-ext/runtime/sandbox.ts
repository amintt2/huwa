// Paperback extension runtime. Runs INSIDE one sandboxed iframe of the hidden WebView (bundled by
// `scripts/build-paperback-runtime.mjs` with cheerio), one iframe per source. It recreates the
// globals a Paperback bundle expects — `App.*` (0.8, @paperback/types 0.8) or `Application.*`
// (0.9, @paperback/types 1.0) — and turns every network / storage access into a message to the
// app. Nothing here is trusted by the app: results are re-validated on the other side.
//
// Reference implementations: @paperback/runtime-polyfills 0.8.7 and 1.0.0-alpha.92 (npm), which
// the Paperback toolchain uses to run extensions outside the iOS app.
import { decodeHTML } from 'entities';

import { md5 } from './md5';
import type { HostToSandbox, HttpRequest, HttpResponse, PaperbackFormat, SandboxToHost, SourceOp } from './protocol';

type Any = any;

export type Transport = { send(msg: string): void; onMessage(cb: (msg: string) => void): void };

const MAX_RESULT = 8 * 1024 * 1024;
const REQUEST_TIMEOUT = 45_000;

// ---------- bytes / text helpers (no Buffer in the WebView) ----------

const utf8 = new TextEncoder();
const bytesOf = (v: ArrayBuffer | ArrayBufferView) =>
  v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const decode = (buf: ArrayBuffer | ArrayBufferView, label = 'utf-8') => new TextDecoder(label).decode(bytesOf(buf));
const bufferOf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** Request body → bytes. Objects become a form (if the content type says so) or JSON. */
function encodeBody(body: unknown, headers: Record<string, string>): Uint8Array | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return utf8.encode(body);
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return bytesOf(body as ArrayBuffer);
  if (typeof body === 'object') {
    const type = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    if (/x-www-form-urlencoded/i.test(type)) {
      return utf8.encode(
        Object.entries(body as Record<string, unknown>)
          .filter(([, v]) => v != null)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&'),
      );
    }
    if (!type) headers['Content-Type'] = 'application/json';
    return utf8.encode(JSON.stringify(body));
  }
  return utf8.encode(String(body));
}

function stringHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (h && typeof h === 'object') for (const [k, v] of Object.entries(h)) if (v != null) out[k] = String(v);
  return out;
}

function addCookieHeader(headers: Record<string, string>, pairs: [string, string][]) {
  if (!pairs.length) return;
  const extra = pairs.map(([k, v]) => `${k}=${v}`).join('; ');
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie');
  if (key) headers[key] = `${headers[key]}; ${extra}`;
  else headers.Cookie = extra;
}

/** JSON-safe copy (Dates become ISO strings), bounded in size. */
function serialize(v: unknown): unknown {
  if (v === undefined) return null;
  const s = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x instanceof ArrayBuffer || ArrayBuffer.isView(x) ? undefined : x));
  if (s === undefined) return null;
  if (s.length > MAX_RESULT) throw new Error('Réponse de la source trop volumineuse');
  return JSON.parse(s);
}

const reviveDate = (x: unknown) => (typeof x === 'string' || typeof x === 'number' ? new Date(x) : undefined);

// ---------- the runtime ----------

export function start(transport: Transport, cheerio: unknown) {
  const send = (m: SandboxToHost) => transport.send(JSON.stringify(m));
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextRid = 1;
  let format: PaperbackFormat = '0.9';
  let ext: Any = null;
  let userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
  let state: Record<string, unknown> = {};
  let secure: Record<string, unknown> = {};

  // Console of the extension → app logs (bounded; useful when a source breaks on device).
  let logBudget = 200;
  const forward = (level: 'log' | 'warn' | 'error') => (...args: unknown[]) => {
    if (logBudget-- <= 0) return;
    const text = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : safeJson(a))).join(' ').slice(0, 500);
    send({ t: 'log', level, text });
  };
  const safeJson = (a: unknown) => {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  const g = globalThis as Any;
  g.console = { log: forward('log'), info: forward('log'), debug: () => {}, warn: forward('warn'), error: forward('error'), trace: () => {} };

  function http(a: HttpRequest): Promise<HttpResponse> {
    const rid = nextRid++;
    send({ t: 'req', rid, m: 'http', a });
    return new Promise<unknown>((resolve, reject) => {
      pending.set(rid, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(rid)) reject(new Error('Délai réseau dépassé'));
      }, REQUEST_TIMEOUT + 5_000);
    }) as Promise<HttpResponse>;
  }

  function setState(isSecure: boolean, key: string, value: unknown) {
    const k = String(key);
    const v = value === undefined ? undefined : serialize(value);
    const target = isSecure ? secure : state;
    if (v === undefined) delete target[k];
    else target[k] = v;
    send({ t: 'state', secure: isSecure, key: k, value: v ?? null });
  }

  // ----- 0.9: Application.* -----
  const selectors = new Map<string, { obj: Any; key: string }>();
  let selectorSeq = 0;
  const SelectorRegistry = {
    registerSelector(id: string, obj: Any, key: string) {
      selectors.set(String(id), { obj, key: String(key) });
    },
    unregisterSelector(id: string) {
      selectors.delete(String(id));
    },
    selector(id: Any) {
      if (typeof id === 'function') return id;
      const ref = selectors.get(String(id));
      if (!ref) return undefined;
      const v = ref.obj[ref.key];
      return typeof v === 'function' ? v.bind(ref.obj) : v;
    },
  };
  const interceptors: { id: string; req: Any; res: Any }[] = [];
  const discover: { section: unknown; selector?: unknown }[] = [];

  async function interceptRequest09(request: Any) {
    let req = request;
    for (const i of interceptors) {
      const fn = SelectorRegistry.selector(i.req);
      if (typeof fn === 'function') req = (await fn(req)) ?? req;
    }
    return req;
  }

  async function perform(req: Any, opts: { timeoutMs?: number; rps?: number } = {}) {
    const headers = stringHeaders(req.headers);
    const body = encodeBody(req.body ?? req.data, headers);
    const res = await http({
      url: String(req.url ?? '') + (req.param ? String(req.param) : ''),
      method: String(req.method ?? 'GET').toUpperCase(),
      headers,
      body64: body ? toBase64(body) : undefined,
      timeoutMs: opts.timeoutMs,
      rps: opts.rps,
    });
    return { res, bytes: fromBase64(res.body64 ?? '') };
  }

  async function scheduleRequest(request: Any): Promise<[Any, ArrayBuffer]> {
    const req = await interceptRequest09({ ...request, headers: stringHeaders(request?.headers) });
    const headers = stringHeaders(req.headers);
    if (req.cookies && typeof req.cookies === 'object') addCookieHeader(headers, Object.entries(req.cookies).map(([k, v]) => [k, String(v)]));
    const { res, bytes } = await perform({ ...req, headers });
    const response = {
      url: res.url,
      headers: res.headers,
      status: res.status,
      mimeType: res.mimeType,
      cookies: res.cookies.map((c) => ({ ...c, expires: c.expires ? new Date(c.expires) : undefined })),
    };
    let data: ArrayBuffer = bufferOf(bytes);
    for (let i = interceptors.length - 1; i >= 0; i--) {
      const fn = SelectorRegistry.selector(interceptors[i].res);
      if (typeof fn === 'function') data = (await fn(req, response, data)) ?? data;
    }
    return [response, data];
  }

  const Application: Record<string, unknown> = {
    isResourceLimited: false,
    filterAdultTitles: false,
    filterMatureTitles: false,
    decodeHTMLEntities: (s: string) => decodeHTML(String(s ?? '')),
    sleep: (seconds: number) => new Promise((r) => setTimeout(r, Math.min(30, Math.max(0, Number(seconds) || 0)) * 1000)),
    registerDiscoverSection(section: Any, selector?: unknown) {
      const i = discover.findIndex((d) => (d.section as Any)?.id === section?.id);
      if (i >= 0) discover.splice(i, 1);
      discover.push({ section, selector });
    },
    unregisterDiscoverSection(id: string) {
      const i = discover.findIndex((d) => (d.section as Any)?.id === id);
      if (i >= 0) discover.splice(i, 1);
    },
    registeredDiscoverSections: () => discover.map((d) => d.section),
    invalidateDiscoverSections: () => {
      discover.length = 0;
    },
    registerInterceptor(id: string, req: unknown, res: unknown) {
      const i = interceptors.findIndex((x) => x.id === id);
      if (i >= 0) interceptors.splice(i, 1);
      interceptors.push({ id: String(id), req, res });
    },
    unregisterInterceptor(id: string) {
      const i = interceptors.findIndex((x) => x.id === id);
      if (i >= 0) interceptors.splice(i, 1);
    },
    setRedirectHandler: () => {},
    getDefaultUserAgent: async () => userAgent,
    scheduleRequest,
    arrayBufferToUTF8String: (b: ArrayBuffer) => decode(b, 'utf-8'),
    arrayBufferToASCIIString: (b: ArrayBuffer) => decode(b, 'ascii'),
    arrayBufferToUTF16String: (b: ArrayBuffer) => decode(b, 'utf-16le'),
    base64Encode(value: string | ArrayBuffer) {
      return toBase64(typeof value === 'string' ? utf8.encode(value) : bytesOf(value));
    },
    base64Decode(value: string | ArrayBuffer) {
      const bytes = typeof value === 'string' ? fromBase64(value) : bytesOf(value);
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return bufferOf(bytes);
      }
    },
    crypto_md5Hash: (value: string | ArrayBuffer) => md5(typeof value === 'string' ? utf8.encode(value) : bytesOf(value)),
    getState: (key: string) => state[String(key)],
    setState: (value: unknown, key: string) => setState(false, key, value),
    getSecureState: (key: string) => secure[String(key)],
    setSecureState: (value: unknown, key: string) => setState(true, key, value),
    resetAllState() {
      for (const k of Object.keys(state)) setState(false, k, undefined);
    },
    executeInWebView: async () => {
      throw new Error('executeInWebView n’est pas pris en charge par Huwa');
    },
    SelectorRegistry,
    Selector(obj: Any, key: string) {
      const slot = `$__selector_${String(key)}`;
      let id = obj[slot];
      if (!id) {
        id = `sel-${++selectorSeq}`;
        Object.defineProperty(obj, slot, { value: id, enumerable: false });
      }
      SelectorRegistry.registerSelector(id, obj, key);
      return id;
    },
    formDidChange: () => {},
  };

  // ----- 0.8: App.* -----
  function rawData(bytes: Uint8Array) {
    const copy = new Uint8Array(bytes);
    Object.defineProperty(copy, 'toString', { value: () => decode(copy), enumerable: false });
    return copy;
  }

  class RequestManager08 {
    interceptor: Any;
    requestsPerSecond: number;
    requestTimeout: number;
    constructor(info: Any = {}) {
      this.interceptor = info?.interceptor;
      this.requestsPerSecond = Number(info?.requestsPerSecond) || 2.5;
      this.requestTimeout = Number(info?.requestTimeout) || 20_000;
    }
    async getDefaultUserAgent() {
      return userAgent;
    }
    async schedule(request: Any, retry = 1) {
      let req = request;
      if (this.interceptor?.interceptRequest) req = (await this.interceptor.interceptRequest(req)) ?? req;
      const headers = stringHeaders(req.headers);
      if (Array.isArray(req.cookies)) addCookieHeader(headers, req.cookies.filter((c: Any) => c?.name).map((c: Any) => [String(c.name), String(c.value ?? '')]));
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) headers['User-Agent'] = userAgent;
      const attempts = 1 + Math.max(0, Math.min(3, Number(retry) || 0));
      let last: unknown;
      for (let i = 0; i < attempts; i++) {
        try {
          const { res, bytes } = await perform({ ...req, headers }, { timeoutMs: this.requestTimeout, rps: this.requestsPerSecond });
          let response: Any = { data: decode(bytes), rawData: rawData(bytes), status: res.status, headers: res.headers, request: req };
          if (this.interceptor?.interceptResponse) response = (await this.interceptor.interceptResponse(response)) ?? response;
          return response;
        } catch (e) {
          last = e;
        }
      }
      throw last;
    }
  }

  class StateManager08 {
    keychain = {
      store: async (key: string, value: unknown) => setState(true, key, value),
      retrieve: async (key: string) => secure[String(key)],
    };
    async store(key: string, value: unknown) {
      setState(false, key, value);
    }
    async retrieve(key: string) {
      return state[String(key)];
    }
  }

  const App08: Record<string, unknown> = {
    createRequestManager: (info: Any) => new RequestManager08(info),
    createSourceStateManager: () => new StateManager08(),
    createRawData: (info: Any) => rawData(bytesOf(info?.byteArray ?? new Uint8Array())),
    createByteArray: (raw: Any) => new Uint8Array(raw),
    createRequest: (info: Any) => ({ ...info, headers: info?.headers ?? {}, cookies: info?.cookies ?? [] }),
  };
  const App = new Proxy(App08, {
    get(target, p) {
      if (typeof p === 'string' && p in target) return target[p];
      // Every other `App.createX(info)` is a plain data constructor in the Paperback app.
      if (typeof p === 'string' && p.startsWith('create')) return (info: unknown) => info;
      return undefined;
    },
  });

  // ----- loading and calls -----

  function load(m: Extract<HostToSandbox, { t: 'load' }>) {
    format = m.format;
    state = m.state && typeof m.state === 'object' ? { ...m.state } : {};
    secure = m.secure && typeof m.secure === 'object' ? { ...m.secure } : {};
    if (m.userAgent) userAgent = m.userAgent;
    g.Application = Application;
    g.App = App;
    // Indirect eval: the bundle's top-level `var source` / `this.Sources` land on this iframe's global.
    (0, eval)(m.code);
    if (format === '0.9') {
      const mod = g.source;
      const inst = mod?.[m.id] ?? Object.values(mod ?? {}).find((x: Any) => x && typeof x.getMangaDetails === 'function');
      if (!inst) throw new Error(`Extension ${m.id} introuvable dans le bundle`);
      ext = inst;
    } else {
      const mod = g.Sources ?? g._Sources;
      const Cls = mod?.[m.id] ?? Object.values(mod ?? {}).find((x: Any) => typeof x === 'function' && x.prototype?.getMangaDetails);
      if (typeof Cls !== 'function') throw new Error(`Source ${m.id} introuvable dans le bundle`);
      ext = new Cls(cheerio);
    }
  }

  async function initialise() {
    if (format === '0.9' && typeof ext.initialise === 'function') await ext.initialise();
  }

  const stripSourceManga = (list: Any) => (Array.isArray(list) ? list.map((c: Any) => (c && typeof c === 'object' ? { ...c, sourceManga: undefined } : c)) : list);

  async function sortingFor(query: Any) {
    if (typeof ext.getSortingOptions !== 'function') return undefined;
    try {
      const opts = await ext.getSortingOptions(query);
      return Array.isArray(opts) ? opts[0] : undefined;
    } catch {
      return undefined;
    }
  }

  async function call(op: SourceOp, args: Any[]): Promise<unknown> {
    if (!ext) throw new Error('Source non chargée');
    switch (op) {
      case 'details':
        return ext.getMangaDetails(String(args[0]));
      case 'chapters':
        if (format === '0.9') return stripSourceManga(await ext.getChapters(args[0]));
        return ext.getChapters(String(args[0]));
      case 'pages': {
        if (format === '0.9') {
          const c = { ...(args[0] as Any), sourceManga: args[1] };
          c.publishDate = reviveDate(c.publishDate);
          c.creationDate = reviveDate(c.creationDate);
          return ext.getChapterDetails(c);
        }
        return ext.getChapterDetails(String(args[0]), String(args[1]));
      }
      case 'search': {
        const title = String(args[0] ?? '');
        const metadata = args[1] ?? undefined;
        if (format === '0.9') {
          const query = { title, metadata: undefined };
          return ext.getSearchResults(query, metadata, await sortingFor(query));
        }
        const query = { title, includedTags: [], excludedTags: [], includeOperator: 'AND', excludeOperator: 'OR', parameters: {} };
        const fn = ext.getSearchResults ?? ext.searchRequest;
        return fn.call(ext, query, metadata ?? {});
      }
      case 'imageHeaders': {
        const url = String(args[0]);
        let req: Any = { url, method: 'GET', headers: {}, cookies: format === '0.9' ? {} : [] };
        if (format === '0.9') req = await interceptRequest09(req);
        else if (ext.requestManager?.interceptor?.interceptRequest) req = (await ext.requestManager.interceptor.interceptRequest(req)) ?? req;
        const headers = stringHeaders(req.headers);
        const pairs = Array.isArray(req.cookies)
          ? req.cookies.filter((c: Any) => c?.name).map((c: Any) => [String(c.name), String(c.value ?? '')] as [string, string])
          : Object.entries(req.cookies ?? {}).map(([k, v]) => [k, String(v)] as [string, string]);
        addCookieHeader(headers, pairs);
        return { url: String(req.url ?? url), headers };
      }
      case 'info':
        return { format, discover: discover.map((d) => d.section) };
      case 'cfRequest': {
        const fn = ext.getCloudflareBypassRequestAsync ?? ext.getCloudflareBypassRequest;
        if (typeof fn !== 'function') return null;
        const req = await fn.call(ext);
        return req && typeof req === 'object' ? { url: String(req.url ?? '') + (req.param ? String(req.param) : ''), headers: stringHeaders(req.headers) } : null;
      }
      case 'cfDone': {
        const req = (args[0] ?? {}) as Any;
        const cookies = (Array.isArray(args[1]) ? args[1] : []).map((c: Any) => ({ ...c, expires: c?.expires ? new Date(c.expires) : undefined }));
        if (typeof ext.cloudflareBypassCompleted === 'function') await ext.cloudflareBypassCompleted({ url: String(req.url ?? ''), method: 'GET', headers: {} }, cookies, {});
        else if (typeof ext.saveCloudflareBypassCookies === 'function') await ext.saveCloudflareBypassCookies(cookies);
        return null;
      }
      case 'discover': {
        if (format === '0.9') {
          let sections: Any = typeof ext.getDiscoverSections === 'function' ? await ext.getDiscoverSections() : undefined;
          if (!Array.isArray(sections) || !sections.length) sections = discover.map((d) => d.section);
          return { sections };
        }
        if (typeof ext.getHomePageSections !== 'function') return { sections: [] };
        // 0.8 sources call back once per section (often twice: empty, then filled): keep the last.
        const byId = new Map<string, Any>();
        const order: string[] = [];
        await ext.getHomePageSections((s: Any) => {
          if (!s || s.id == null) return;
          const id = String(s.id);
          if (!byId.has(id)) order.push(id);
          byId.set(id, { ...s, items: Array.isArray(s.items) ? [...s.items] : s.items });
        });
        return { sections: order.map((id) => byId.get(id)) };
      }
      case 'discoverItems': {
        const metadata = args[1] ?? undefined;
        if (format === '0.9') {
          const section = args[0] as Any;
          const registered = discover.find((d) => (d.section as Any)?.id === section?.id);
          const fn = registered?.selector ? SelectorRegistry.selector(registered.selector) : undefined;
          if (typeof fn === 'function') return fn(section, metadata);
          if (typeof ext.getDiscoverSectionItems !== 'function') return { items: [] };
          return ext.getDiscoverSectionItems(section, metadata);
        }
        if (typeof ext.getViewMoreItems !== 'function') return { results: [] };
        return ext.getViewMoreItems(String(args[0]), metadata ?? {});
      }
    }
  }

  const message = (e: unknown) => {
    if (e && typeof e === 'object') {
      const err = e as { name?: string; message?: string };
      return String(err.message || err.name || 'Erreur').slice(0, 300);
    }
    return String(e).slice(0, 300);
  };

  /** 0.9 `CloudflareError` (carries the page to open), or a 0.8 error that names Cloudflare. */
  const cloudflareOf = (e: unknown): { url?: string } | undefined => {
    if (!e || typeof e !== 'object') return undefined;
    const err = e as { name?: string; type?: string; message?: string; resolutionRequest?: Any };
    const typed = err.type === 'cloudflareError' || err.name === 'CloudflareError' || (err.resolutionRequest && typeof err.resolutionRequest === 'object');
    if (!typed && !/cloudflare|bypass error/i.test(err.message ?? '')) return undefined;
    const r = err.resolutionRequest;
    const url = r && typeof r === 'object' && r.url ? String(r.url) + (r.param ? String(r.param) : '') : undefined;
    return { url };
  };

  transport.onMessage((raw) => {
    let m: HostToSandbox;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.t === 'res') {
      const p = pending.get(m.rid);
      if (!p) return;
      pending.delete(m.rid);
      if (m.ok) p.resolve(m.v);
      else p.reject(new Error(m.e ?? 'Erreur réseau'));
    } else if (m.t === 'load') {
      Promise.resolve()
        .then(() => load(m))
        .then(initialise)
        .then(
          () => send({ t: 'loaded', ok: true }),
          (e) => send({ t: 'loaded', ok: false, e: message(e) }),
        );
    } else if (m.t === 'call') {
      Promise.resolve()
        .then(() => call(m.op, Array.isArray(m.args) ? m.args : []))
        .then(serialize)
        .then(
          (v) => send({ t: 'ret', cid: m.cid, ok: true, v }),
          (e) => send({ t: 'ret', cid: m.cid, ok: false, e: message(e), cf: cloudflareOf(e) }),
        );
    }
  });
  send({ t: 'ready' });
}
