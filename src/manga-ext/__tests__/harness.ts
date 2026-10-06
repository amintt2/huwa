// Test harness: runs the real sandbox bundle (esbuild of runtime/entry.ts, same as the app) in a
// Node `vm` context that only has browser-like globals, and plays the app side of the protocol.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { CookieJar, createNet, readCapped, type RawFetch } from '../net';
import type { HostToSandbox, HttpRequest, HttpResponse, PaperbackFormat, SandboxToHost, SourceOp } from '../runtime/protocol';

let runtime: Promise<string> | undefined;
export function runtimeCode() {
  runtime ??= build({
    entryPoints: [fileURLToPath(new URL('../runtime/entry.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'safari15',
    write: false,
    logLevel: 'silent',
  }).then((r) => r.outputFiles[0].text);
  return runtime;
}

export type NodeSandbox = {
  load(id: string, format: PaperbackFormat, code: string, state?: Record<string, unknown>): Promise<void>;
  call<T = unknown>(op: SourceOp, ...args: unknown[]): Promise<T>;
  state: Record<string, unknown>;
  logs: string[];
  requests: HttpRequest[];
};

export async function createNodeSandbox(handle: (req: HttpRequest) => Promise<HttpResponse>): Promise<NodeSandbox> {
  const code = await runtimeCode();
  let deliver: (msg: string) => void = () => {};
  const waiting = new Map<string, (m: SandboxToHost) => void>();
  const state: Record<string, unknown> = {};
  const logs: string[] = [];
  const requests: HttpRequest[] = [];
  const toSandbox = (m: HostToSandbox) => setImmediate(() => deliver(JSON.stringify(m)));

  const onSandbox = (raw: string) => {
    const m = JSON.parse(raw) as SandboxToHost;
    if (m.t === 'ready') waiting.get('ready')?.(m);
    else if (m.t === 'loaded') waiting.get('loaded')?.(m);
    else if (m.t === 'ret') waiting.get(`ret${m.cid}`)?.(m);
    else if (m.t === 'state') {
      if (!m.secure) state[m.key] = m.value;
    } else if (m.t === 'log') logs.push(`${m.level}: ${m.text}`);
    else if (m.t === 'req') {
      requests.push(m.a);
      handle(m.a).then(
        (v) => toSandbox({ t: 'res', rid: m.rid, ok: true, v }),
        (e) => toSandbox({ t: 'res', rid: m.rid, ok: false, e: e instanceof Error ? e.message : String(e) }),
      );
    }
  };
  const once = (key: string) => new Promise<SandboxToHost>((r) => waiting.set(key, (m) => (waiting.delete(key), r(m))));

  const context = vm.createContext({
    TextDecoder, TextEncoder, atob, btoa, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    queueMicrotask, console, crypto, Intl, WeakRef, FinalizationRegistry,
    __transport: {
      send: (s: string) => onSandbox(s),
      onMessage: (cb: (s: string) => void) => {
        deliver = cb;
      },
    },
  });
  const ready = once('ready');
  vm.runInContext(code, context);
  vm.runInContext('HuwaPB.start(__transport, HuwaPB.cheerio); delete globalThis.__transport; delete globalThis.HuwaPB;', context);
  await ready;

  let cid = 0;
  return {
    state,
    logs,
    requests,
    async load(id, format, source, initial = {}) {
      Object.assign(state, initial);
      const done = once('loaded');
      toSandbox({ t: 'load', id, format, code: source, state: { ...state }, secure: {}, userAgent: 'HuwaTest/1.0' });
      const r = (await done) as Extract<SandboxToHost, { t: 'loaded' }>;
      if (!r.ok) throw new Error(r.e);
    },
    async call<T>(op: SourceOp, ...args: unknown[]) {
      const id = ++cid;
      const done = once(`ret${id}`);
      toSandbox({ t: 'call', cid: id, op, args });
      const r = (await done) as Extract<SandboxToHost, { t: 'ret' }>;
      if (!r.ok) throw Object.assign(new Error(r.e), { cf: r.cf });
      return r.v as T;
    },
  };
}

/** Real network through the app's policy layer (`net.ts`), with Node's fetch as transport. */
export const nodeFetch: RawFetch = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body as BodyInit | undefined, signal: init.signal, redirect: init.redirect });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  const body = res.body ? await readCapped(res.body.getReader(), init.maxBytes) : new Uint8Array(0);
  return { url: res.url || url, status: res.status, headers, setCookies: res.headers.getSetCookie(), body };
};

export function nodeNet() {
  const jars = new Map<string, CookieJar>();
  return createNet(nodeFetch, { jar: (k) => jars.get(k) ?? (jars.set(k, new CookieJar()), jars.get(k)!) });
}
