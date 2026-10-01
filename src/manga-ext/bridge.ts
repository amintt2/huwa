// App side of the extension runtime: drives the hidden WebView (`PaperbackHost`), one sandboxed
// iframe per source, and serves what the sandboxes ask for (network through `net.ts`, their own
// state through `state.ts`). Nothing coming back is trusted: callers validate with `validate.ts`.
import { useSyncExternalStore } from 'react';

import { createNet, DEFAULT_USER_AGENT } from './net';
import { rnFetch } from './net-rn';
import type { HostToSandbox, HttpRequest, PaperbackFormat, SandboxToHost, SourceOp } from './runtime/protocol';
import { jarFor, loadSourceState, setSourceValue } from './state';

const MAX_FRAMES = 4;
const READY_TIMEOUT = 20_000;
const LOAD_TIMEOUT = 40_000;
const CALL_TIMEOUT = 60_000;
const MAX_INFLIGHT = 24;

export type SourceCode = { id: string; format: PaperbackFormat; code: string };
type CodeLoader = (key: string) => Promise<SourceCode>;

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

type Frame = {
  key: string;
  ready: Deferred<void>;
  loaded: Deferred<void>;
  calls: Map<number, Deferred<unknown>>;
  inflight: number;
  lastUsed: number;
};

const net = createNet(rnFetch, { jar: jarFor });
const frames = new Map<string, Frame>();
let inject: ((js: string) => void) | null = null;
let hostReady = deferred<void>();
let codeLoader: CodeLoader | null = null;
let nextCid = 1;

// ---------- host (WebView) lifecycle, observed by PaperbackHost ----------

type HostState = { needed: boolean; generation: number };
let host: HostState = { needed: false, generation: 0 };
const hostListeners = new Set<() => void>();
const setHost = (p: Partial<HostState>) => {
  host = { ...host, ...p };
  hostListeners.forEach((l) => l());
};
export const useHostState = () =>
  useSyncExternalStore(
    (l) => {
      hostListeners.add(l);
      return () => hostListeners.delete(l);
    },
    () => host,
    () => host,
  );

export function setCodeLoader(fn: CodeLoader) {
  codeLoader = fn;
}

/** Called by PaperbackHost when its WebView mounts / unmounts. */
export function attachHost(fn: ((js: string) => void) | null) {
  inject = fn;
}

function post(o: unknown) {
  inject?.(`window.__huwaIn(${JSON.stringify(JSON.stringify(o))});true;`);
}
const toFrame = (key: string, msg: HostToSandbox) => post({ t: 'to', key, msg: JSON.stringify(msg) });

function failAll(reason: string) {
  const err = new Error(reason);
  for (const f of frames.values()) {
    f.ready.reject(err);
    f.loaded.reject(err);
    f.calls.forEach((c) => c.reject(err));
  }
  frames.clear();
}

/** The WebView content process died or hung: drop every sandbox and remount it. */
export function resetHost(reason = 'Moteur d’extensions redémarré') {
  failAll(reason);
  hostReady.reject(new Error(reason));
  hostReady = deferred<void>();
  setHost({ generation: host.generation + 1 });
}

export function killFrame(key: string) {
  const f = frames.get(key);
  if (!f) return;
  frames.delete(key);
  const err = new Error('Source déchargée');
  f.ready.reject(err);
  f.loaded.reject(err);
  f.calls.forEach((c) => c.reject(err));
  post({ t: 'kill', key });
}

// ---------- messages from the WebView ----------

export function onHostMessage(raw: string) {
  let m: { t: string; key?: string; msg?: string };
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.t === 'host-ready') {
    hostReady.resolve();
    return;
  }
  if (m.t === 'pong') {
    [...pongs].forEach((p) => p());
    return;
  }
  if (m.t !== 'from' || typeof m.key !== 'string' || typeof m.msg !== 'string') return;
  const f = frames.get(m.key);
  if (!f) return;
  let msg: SandboxToHost;
  try {
    msg = JSON.parse(m.msg);
  } catch {
    return;
  }
  handleFrame(f, msg);
}

function handleFrame(f: Frame, msg: SandboxToHost) {
  switch (msg?.t) {
    case 'ready':
      f.ready.resolve();
      break;
    case 'loaded':
      if (msg.ok) f.loaded.resolve();
      else f.loaded.reject(new Error(typeof msg.e === 'string' ? msg.e.slice(0, 300) : 'Chargement impossible'));
      break;
    case 'ret': {
      const c = f.calls.get(msg.cid);
      if (!c) return;
      f.calls.delete(msg.cid);
      if (msg.ok) c.resolve(msg.v);
      else c.reject(new Error(typeof msg.e === 'string' ? msg.e.slice(0, 300) : 'Erreur de la source'));
      break;
    }
    case 'req': {
      if (typeof msg.rid !== 'number') return;
      const reply = (ok: boolean, v?: unknown, e?: string) => toFrame(f.key, { t: 'res', rid: msg.rid, ok, v, e });
      if (msg.m !== 'http') return reply(false, undefined, 'Requête inconnue');
      if (f.inflight >= MAX_INFLIGHT) return reply(false, undefined, 'Trop de requêtes simultanées');
      f.inflight++;
      net
        .request(f.key, msg.a as HttpRequest)
        .then(
          (v) => reply(true, v),
          (e) => reply(false, undefined, e instanceof Error ? e.message : 'Erreur réseau'),
        )
        .finally(() => {
          f.inflight--;
        });
      break;
    }
    case 'state':
      setSourceValue(f.key, !!msg.secure, msg.key, msg.value);
      break;
    case 'log':
      if (__DEV__) console.log(`[paperback:${f.key}] ${String(msg.text).slice(0, 500)}`);
      break;
  }
}

// ---------- loading and calling sources ----------

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(label)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * After a timeout: a source stuck in a loop (while evaluating, in `initialise()` or in a call)
 * blocks the whole WebView thread, so killing its frame cannot even be delivered. If the host no
 * longer answers a ping, remount it; otherwise only this frame is dropped.
 */
async function recoverFrom(key: string, f: Frame, why: string) {
  if (!(await hostAlive())) resetHost(why);
  else if (frames.get(key) === f) killFrame(key);
}

function evict() {
  if (frames.size <= MAX_FRAMES) return;
  const oldest = [...frames.values()].filter((f) => f.calls.size === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
  if (oldest) killFrame(oldest.key);
}

async function ensureLoaded(key: string): Promise<Frame> {
  const existing = frames.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    await existing.loaded.promise;
    return existing;
  }
  if (!codeLoader) throw new Error('Extensions indisponibles');
  if (!host.needed) setHost({ needed: true });
  const f: Frame = { key, ready: deferred(), loaded: deferred(), calls: new Map(), inflight: 0, lastUsed: Date.now() };
  frames.set(key, f);
  try {
    const [src] = await Promise.all([codeLoader(key), withTimeout(hostReady.promise, READY_TIMEOUT, 'Moteur d’extensions indisponible')]);
    const st = await loadSourceState(key);
    post({ t: 'spawn', key });
    await withTimeout(f.ready.promise, READY_TIMEOUT, 'La source ne démarre pas');
    toFrame(key, { t: 'load', id: src.id, format: src.format, code: src.code, state: st.state, secure: st.secure, userAgent: DEFAULT_USER_AGENT });
    await withTimeout(f.loaded.promise, LOAD_TIMEOUT, 'Chargement de la source trop long');
    evict();
    return f;
  } catch (e) {
    if (e instanceof TimeoutError) await recoverFrom(key, f, 'Source bloquée au chargement, moteur redémarré');
    else if (frames.get(key) === f) killFrame(key);
    throw e;
  }
}

/** Calls an operation on an installed source. The result is raw and must be validated. */
export async function callSource(key: string, op: SourceOp, args: unknown[], timeout = CALL_TIMEOUT): Promise<unknown> {
  const f = await ensureLoaded(key);
  const cid = nextCid++;
  const d = deferred<unknown>();
  f.calls.set(cid, d);
  f.lastUsed = Date.now();
  toFrame(key, { t: 'call', cid, op, args });
  try {
    return await withTimeout(d.promise, timeout, 'La source ne répond pas');
  } catch (e) {
    if (f.calls.delete(cid) && e instanceof TimeoutError) await recoverFrom(key, f, 'Source bloquée, moteur redémarré');
    throw e;
  }
}

const pongs = new Set<() => void>();
function hostAlive(): Promise<boolean> {
  if (!inject) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (alive: boolean) => {
      clearTimeout(timer);
      pongs.delete(onPong);
      resolve(alive);
    };
    const onPong = () => done(true);
    const timer = setTimeout(() => done(false), 3_000);
    pongs.add(onPong);
    post({ t: 'ping' });
  });
}
