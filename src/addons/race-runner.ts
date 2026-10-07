// Network side of the source race (see ./race.ts for the rules): one small ranged GET per link,
// bounded concurrency, results cached for the session with a short TTL, everything cancelled when
// the screen goes away. On device the request is an XMLHttpRequest (React Native's fetch only
// resolves once the whole body is read, so a server ignoring `Range` would send the whole video);
// elsewhere (Node, tests) a streamed fetch.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { evaluateMeasure, type RaceResult, type RawMeasure } from './race';

export type ProbeOptions = { bytes: number; timeoutMs: number; signal?: AbortSignal };
export type Transport = (url: string, headers: Record<string, string> | undefined, o: ProbeOptions) => Promise<RawMeasure>;

const HEAD_BYTES = 64;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** XMLHttpRequest transport: aborts at the headers when the server ignores `Range` (200). */
export const xhrTransport: Transport = (url, headers, { bytes, timeoutMs, signal }) =>
  new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const t0 = now();
    let ttfb: number | undefined;
    let done = false;
    const finish = (m: RawMeasure) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(m);
    };
    const meta = () => ({ status: xhr.status, contentType: xhr.getResponseHeader('Content-Type'), contentRange: xhr.getResponseHeader('Content-Range') });
    const onAbort = () => {
      xhr.abort();
      finish({ status: 0, bytes: 0 });
    };
    const timer = setTimeout(() => {
      const headersSeen = ttfb != null;
      const m = headersSeen ? meta() : null;
      xhr.abort();
      finish(m ? { ...m, bytes: 0, ttfbMs: ttfb, timedOut: true } : { status: 0, bytes: 0, timedOut: true });
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort);
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    for (const [k, v] of Object.entries(headers ?? {})) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader('Range', `bytes=0-${bytes - 1}`);
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 2 && ttfb == null) {
        ttfb = now() - t0;
        // Whole-file answer (Range ignored) or an error page: headers are enough, drop the body.
        if (xhr.status !== 206) {
          const m = meta();
          const ct = (m.contentType ?? '').toLowerCase();
          // Small error/HTML bodies are worth reading (sniffing); a 200 video is not.
          if (xhr.status === 200 && !ct.startsWith('text/') && !ct.includes('json')) {
            xhr.abort();
            finish({ ...m, bytes: 0, ttfbMs: ttfb });
          }
        }
      }
    };
    xhr.onload = () => {
      const buf = xhr.response as ArrayBuffer | null;
      const body = buf ? new Uint8Array(buf) : null;
      finish({ ...meta(), bytes: body?.length ?? 0, head: body?.subarray(0, HEAD_BYTES) ?? null, ttfbMs: ttfb ?? now() - t0, totalMs: now() - t0 });
    };
    xhr.onerror = () => finish({ status: 0, bytes: 0 });
    xhr.send();
  });

/** Streamed fetch transport (Node 18+, web): reads at most `bytes` then cancels. */
export const fetchTransport: Transport = async (url, headers, { bytes, timeoutMs, signal }) => {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const t0 = now();
  let ttfb: number | undefined;
  let meta: { status: number; contentType: string | null; contentRange: string | null } | undefined;
  let n = 0;
  let head: Uint8Array | null = null;
  try {
    const res = await fetch(url, { headers: { ...headers, Range: `bytes=0-${bytes - 1}` }, signal: ctrl.signal });
    ttfb = now() - t0;
    meta = { status: res.status, contentType: res.headers.get('content-type'), contentRange: res.headers.get('content-range') };
    const ct = (meta.contentType ?? '').toLowerCase();
    if (res.status === 200 && !ct.startsWith('text/') && !ct.includes('json')) {
      ctrl.abort();
      return { ...meta, bytes: 0, ttfbMs: ttfb };
    }
    const reader = res.body?.getReader();
    while (reader && n < bytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      if (!head) head = value.subarray(0, HEAD_BYTES);
      n += value.length;
    }
    ctrl.abort();
    return { ...meta, bytes: n, head, ttfbMs: ttfb, totalMs: now() - t0 };
  } catch {
    if (meta) return { ...meta, bytes: n, head, ttfbMs: ttfb, timedOut };
    return { status: 0, bytes: 0, timedOut };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

const defaultTransport: Transport = typeof XMLHttpRequest !== 'undefined' ? xhrTransport : fetchTransport;

// ---------- session cache ----------

/** Alive results are trusted for a few minutes (debrid links are short-lived), dead ones a bit less. */
export const ALIVE_TTL_MS = 5 * 60_000;
export const DEAD_TTL_MS = 2 * 60_000;
const MAX_CACHE = 300;

const results = new Map<string, RaceResult>();
const inflight = new Map<string, Flight>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

const fresh = (r: RaceResult | undefined, at = Date.now()) => !!r && at - r.at < (r.alive ? ALIVE_TTL_MS : DEAD_TTL_MS);

export function cachedRace(url: string): RaceResult | undefined {
  const r = results.get(url);
  return fresh(r) ? r : undefined;
}

/** Last result for `url`, however old (a screen keeps what its own race measured). */
const peekRace = (url: string) => results.get(url);

/** Records a verdict learned elsewhere (e.g. the player failed on a link). */
export function rememberRace(url: string, r: RaceResult) {
  results.delete(url);
  results.set(url, r);
  if (results.size > MAX_CACHE) results.delete(results.keys().next().value!);
  emit();
}

/** Test helper. */
export function clearRaceCache() {
  results.clear();
  inflight.clear();
  emit();
}

/**
 * Measures one link (deduplicated, cached). Resolves undefined when the caller's signal aborts
 * before an answer (nothing is cached then). Callers share one request: it is only cancelled when
 * every caller has given up, so a pre-search handing over to the watch screen keeps its probe.
 */
export function measureUrl(
  url: string,
  headers: Record<string, string> | undefined,
  o: ProbeOptions,
  transport: Transport = defaultTransport,
  /** Measure again even when a fresh result is cached (background re-probes while playing). */
  refresh = false,
): Promise<RaceResult | undefined> {
  const hit = refresh ? undefined : cachedRace(url);
  if (hit) return Promise.resolve(hit);
  let f = inflight.get(url);
  if (!f) {
    const ctrl = new AbortController();
    const entry: Flight = { ctrl, waiters: 0, promise: Promise.resolve(undefined) };
    entry.promise = transport(url, headers, { ...o, signal: ctrl.signal })
      .then((raw) => {
        if (ctrl.signal.aborted) return undefined;
        const r = evaluateMeasure(raw);
        rememberRace(url, r);
        return r;
      })
      .catch(() => undefined)
      .finally(() => {
        if (inflight.get(url) === entry) inflight.delete(url);
      });
    inflight.set(url, entry);
    f = entry;
  }
  const flight = f;
  flight.waiters++;
  const signal = o.signal;
  if (!signal) return flight.promise;
  if (signal.aborted) {
    leave(url, flight);
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    const onAbort = () => {
      leave(url, flight);
      resolve(undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    flight.promise.then((r) => {
      signal.removeEventListener('abort', onAbort);
      if (!signal.aborted) resolve(r);
    });
  });
}

type Flight = { ctrl: AbortController; waiters: number; promise: Promise<RaceResult | undefined> };

/** One caller gave up: cancel the shared request when nobody waits for it any more. */
function leave(url: string, f: Flight) {
  f.waiters--;
  if (f.waiters <= 0) {
    f.ctrl.abort();
    if (inflight.get(url) === f) inflight.delete(url);
  }
}

/** Runs `jobs` with at most `concurrency` at a time; stops starting new ones once `signal` aborts. */
export async function runPool<T>(items: T[], concurrency: number, job: (item: T) => Promise<unknown>, signal?: AbortSignal) {
  let i = 0;
  const worker = async () => {
    while (i < items.length && !signal?.aborted) {
      const item = items[i++];
      await job(item).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

/**
 * Background re-probes while an episode plays (source controller): each link measured again with
 * the race's probe size, at most `concurrency` at a time. The new results replace the old ones in
 * the cache (the sources menu and the controller see them). Resolves when all answered.
 */
export async function remeasure(entries: RaceEntry[], budget: RaceBudget, signal?: AbortSignal, transport: Transport = defaultTransport) {
  if (budget.max <= 0) return;
  await runPool(
    dedupe(entries).slice(0, budget.max),
    Math.max(1, budget.concurrency),
    (e) => measureUrl(e.url, e.headers, { bytes: budget.bytes, timeoutMs: budget.timeoutMs, signal }, transport, true),
    signal,
  );
}

// ---------- hook ----------

export type RaceBudget = {
  /** Links measured per screen (0 = no race). */
  max: number;
  concurrency: number;
  bytes: number;
  timeoutMs: number;
};

export type RaceEntry = { url: string; headers?: Record<string, string> };

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const getVersion = () => version;

/**
 * Measures `entries` (in priority order, the first `budget.max` distinct URLs), at most
 * `budget.concurrency` at a time. Links added later (slow addons) join the queue while the budget
 * lasts; nothing already started is restarted. Everything is cancelled when `enabled` turns false
 * or the component unmounts. Returns what is known per URL, the URLs that will still answer, and
 * the race start (`raceClock` ms) for the grace window and deadlines.
 */
export function useRace(entries: RaceEntry[], budget: RaceBudget, enabled: boolean) {
  const all = enabled ? dedupe(entries) : [];
  const selected = budget.max > 0 ? all.slice(0, budget.max) : [];
  const key = selected.map((e) => e.url).join('\n');
  // Every link of the screen, for results (a link pushed out of the top N keeps its label).
  const allKey = all.map((e) => e.url).join('\n');
  // One session per hook instance (mutable object, identity stable across renders).
  const [session] = useState(() => new RaceSession());
  const [failedVersion, setFailedVersion] = useState(0);
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);

  // Stop everything when disabled / unmounted.
  useEffect(() => {
    if (!enabled) return;
    return () => session.stop();
  }, [enabled, session]);

  useEffect(() => {
    if (!selected.length) return;
    session.add(selected, budget, () => setFailedVersion((n) => n + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, budget.bytes, budget.concurrency, budget.timeoutMs, session]);

  // Stable between store changes (callers memoize on them).
  const results = useMemo(() => {
    const out: Record<string, RaceResult> = {};
    for (const url of allKey ? allKey.split('\n') : []) {
      // This race's own measurements stay valid for the screen; others only while fresh.
      const r = session.doneAt.has(url) ? peekRace(url) : cachedRace(url);
      if (r) out[url] = r;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allKey, v, session]);
  const probing = useMemo<ReadonlySet<string>>(
    () => new Set((key ? key.split('\n') : []).filter((u) => !results[u] && !session.failed.has(u))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, results, failedVersion, session],
  );
  return {
    results,
    /** URLs whose answer is still expected (queued, in flight, or about to start). */
    probing,
    /** Race start (`raceClock` ms), null before the first link is queued. */
    startedAt: session.startedAt,
    /** Elapsed race time (ms) at which a URL answered in this race (undefined = from the cache). */
    doneAt: (url: string) => session.doneAt.get(url),
  };
}

/** Queue + bounded workers of one screen's race. */
class RaceSession {
  ctrl = new AbortController();
  startedAt: number | null = null;
  started = new Set<string>();
  failed = new Set<string>();
  doneAt = new Map<string, number>();
  private queue: RaceEntry[] = [];
  private active = 0;

  add(entries: RaceEntry[], budget: RaceBudget, onFailed: () => void) {
    this.startedAt ??= now();
    const todo = entries.filter((e) => !cachedRace(e.url) && !this.started.has(e.url));
    for (const e of todo) this.started.add(e.url);
    this.queue.push(...todo);
    this.pump(budget, onFailed);
  }

  private pump(budget: RaceBudget, onFailed: () => void) {
    const ctrl = this.ctrl;
    while (this.active < Math.max(1, budget.concurrency) && this.queue.length && !ctrl.signal.aborted) {
      const e = this.queue.shift()!;
      this.active++;
      measureUrl(e.url, e.headers, { bytes: budget.bytes, timeoutMs: budget.timeoutMs, signal: ctrl.signal })
        .then((res) => {
          if (ctrl.signal.aborted) return;
          if (res) this.doneAt.set(e.url, now() - (this.startedAt ?? now()));
          else {
            this.failed.add(e.url);
            onFailed();
          }
        })
        .finally(() => {
          // A stopped session already reset its counters.
          if (ctrl !== this.ctrl) return;
          this.active--;
          this.pump(budget, onFailed);
        });
    }
  }

  /** Cancels queued and in-flight measurements; links not measured may be retried later. */
  stop() {
    this.ctrl.abort();
    this.ctrl = new AbortController();
    this.queue = [];
    this.active = 0;
    this.started.clear();
  }
}

function dedupe(entries: RaceEntry[]) {
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)));
}

export { now as raceClock };
