// Persisted stale-while-revalidate cache (pure: no React, no React Native), unit tested in
// src/data/__tests__/swr-core.test.ts. The app instance and its React hook live in ./swr.ts.
//
// · Entries live in memory and on disk (AsyncStorage: IndexedDB on the web), one storage key per
//   entry under a versioned prefix (`huwa/swr/v1/…`). Bumping `version` drops every older entry
//   (they are purged from storage on first use).
// · A small index (key → written at, size, last used) is kept in one storage key, so a miss never
//   touches the disk and the size cap is enforced without reading entries back: least recently
//   used entries go first when there are more than `maxEntries` or more than `maxBytes`.
// · `swr()` answers from the cache at once (as long as the entry is younger than `maxStale`) and
//   refreshes it in the background when it is older than `ttl`; `load()` waits for fresh data
//   when the entry is stale (and falls back to it when the network fails).
// · Identical requests in flight are shared (one network call per key at a time).
// · Listeners only hear about a key when its value really changed (JSON-wise): a refresh that
//   brings the same data back does not re-render anything.

export type SwrStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys?(): Promise<readonly string[]>;
};

export type SwrEntry<T> = { value: T; at: number };

/** What a screen sees of one key. A new object only when something it shows changed. */
export type SwrState<T> = {
  entry?: SwrEntry<T>;
  /** A network request for this key is running. */
  pending: boolean;
  /** Last refresh failed (cleared by the next success). */
  error?: unknown;
};

export type SwrOptions = {
  /** Age after which an entry is refreshed (ms). */
  ttl: number;
  /** Age after which an entry is not shown anymore, even offline (ms). Default: forever. */
  maxStale?: number;
  /** Refresh even when the entry is fresh. */
  force?: boolean;
};

export type SwrConfig = {
  storage: SwrStorage;
  /** Storage key prefix, e.g. `huwa/swr/`. The version is appended (`huwa/swr/v1/`). */
  prefix: string;
  version: number;
  maxEntries: number;
  /** Cap on the serialized size of all entries (UTF-16 code units, close enough to bytes). */
  maxBytes: number;
  now?: () => number;
};

type IndexRow = { at: number; size: number; used: number };
type Mem<T> = { entry: SwrEntry<T>; raw: string };

const EMPTY: SwrState<never> = Object.freeze({ pending: false }) as SwrState<never>;

export function createSwrCache(config: SwrConfig) {
  const { storage, maxEntries, maxBytes } = config;
  const now = config.now ?? Date.now;
  const base = `${config.prefix}v${config.version}/`;
  const INDEX_KEY = `${base}_index`;
  const entryKey = (key: string) => `${base}e/${key}`;

  const memory = new Map<string, Mem<unknown>>();
  const index = new Map<string, IndexRow>();
  const states = new Map<string, SwrState<unknown>>();
  const listeners = new Map<string, Set<() => void>>();
  const inflight = new Map<string, Promise<unknown>>();
  let bytes = 0;
  let writes: Promise<unknown> = Promise.resolve();
  let indexDirty = false;
  let indexTimer: ReturnType<typeof setTimeout> | undefined;

  /** Storage writes run one after another (index and entries stay consistent). */
  const queue = (op: () => Promise<unknown>) => {
    writes = writes.then(op).catch(() => {});
    return writes;
  };

  const ready: Promise<void> = (async () => {
    try {
      const raw = await storage.getItem(INDEX_KEY);
      const rows = raw ? (JSON.parse(raw) as [string, number, number, number][]) : [];
      for (const [k, at, size, used] of rows) {
        if (typeof k !== 'string' || !Number.isFinite(at) || !Number.isFinite(size)) continue;
        index.set(k, { at, size, used: Number.isFinite(used) ? used : at });
        bytes += size;
      }
    } catch {
      // Corrupted index: start empty (orphan entries are overwritten or purged below).
    }
    // Entries of older versions (and of this one missing from the index) are dropped once.
    try {
      const keys = (await storage.getAllKeys?.()) ?? [];
      const stale = keys.filter(
        (k) => k.startsWith(config.prefix) && k !== INDEX_KEY && (!k.startsWith(base) || !index.has(k.slice(base.length + 2))),
      );
      for (const k of stale) await storage.removeItem(k).catch(() => {});
    } catch {
      // no key listing on this storage: older versions just stay until cleared
    }
  })();

  function persistIndex() {
    indexDirty = true;
    if (indexTimer) return;
    indexTimer = setTimeout(() => {
      indexTimer = undefined;
      void flushIndex();
    }, 50);
  }

  function flushIndex() {
    if (!indexDirty) return writes;
    indexDirty = false;
    const rows = [...index].map(([k, r]) => [k, r.at, r.size, r.used]);
    return queue(() => storage.setItem(INDEX_KEY, JSON.stringify(rows)));
  }

  function emit(key: string) {
    listeners.get(key)?.forEach((l) => l());
  }

  function setState<T>(key: string, patch: Partial<SwrState<T>>) {
    const cur = (states.get(key) ?? EMPTY) as SwrState<T>;
    const next = { ...cur, ...patch };
    if (next.entry === cur.entry && next.pending === cur.pending && next.error === cur.error) return;
    states.set(key, next as SwrState<unknown>);
    emit(key);
  }

  function dropFromIndex(key: string) {
    const row = index.get(key);
    if (!row) return;
    bytes -= row.size;
    index.delete(key);
  }

  /** Least recently used entries out until both caps hold (`keep`, just written, is spared). */
  function evict(keep?: string) {
    if (index.size <= maxEntries && bytes <= maxBytes) return;
    const order = [...index].sort((a, b) => a[1].used - b[1].used);
    for (const [k] of order) {
      if (index.size <= maxEntries && bytes <= maxBytes) break;
      if (k === keep) continue;
      dropFromIndex(k);
      memory.delete(k);
      if (states.has(k)) setState(k, { entry: undefined });
      void queue(() => storage.removeItem(entryKey(k)));
    }
  }

  function touch(key: string) {
    const row = index.get(key);
    if (!row) return;
    row.used = now();
    persistIndex();
  }

  /** Entry from memory only (synchronous: first render of a screen). */
  function peek<T>(key: string): SwrEntry<T> | undefined {
    return memory.get(key)?.entry as SwrEntry<T> | undefined;
  }

  /** Entry from memory, else from disk. */
  async function get<T>(key: string): Promise<SwrEntry<T> | undefined> {
    const hit = memory.get(key);
    if (hit) {
      touch(key);
      return hit.entry as SwrEntry<T>;
    }
    await ready;
    if (!index.has(key)) return undefined;
    let parsed: { at: number; v: T } | undefined;
    try {
      const raw = await storage.getItem(entryKey(key));
      parsed = raw ? (JSON.parse(raw) as { at: number; v: T }) : undefined;
    } catch {
      parsed = undefined;
    }
    // Written meanwhile (a refresh that finished first): memory wins.
    const mem = memory.get(key);
    if (mem) return mem.entry as SwrEntry<T>;
    if (!parsed || typeof parsed.at !== 'number' || !('v' in parsed)) {
      dropFromIndex(key);
      persistIndex();
      void queue(() => storage.removeItem(entryKey(key)));
      return undefined;
    }
    const entry: SwrEntry<T> = { value: parsed.v, at: parsed.at };
    memory.set(key, { entry, raw: JSON.stringify(parsed.v) });
    touch(key);
    setState(key, { entry });
    return entry;
  }

  /** Stores a value. Returns true when it differs from what was cached. */
  async function set<T>(key: string, value: T, at = now()): Promise<boolean> {
    await ready;
    const raw = JSON.stringify(value);
    const prev = memory.get(key);
    const changed = !prev || prev.raw !== raw;
    const entry: SwrEntry<T> = changed ? { value, at } : { value: prev.entry.value as T, at };
    memory.set(key, { entry, raw });
    dropFromIndex(key);
    const size = raw.length + key.length;
    if (size <= maxBytes) {
      index.set(key, { at, size, used: now() });
      bytes += size;
      evict(key);
      void queue(() => storage.setItem(entryKey(key), JSON.stringify({ at, v: value })));
    } else {
      // Bigger than the whole budget: memory only (it would push every other entry out).
      void queue(() => storage.removeItem(entryKey(key)));
    }
    // Right away (not debounced like "last used"): an entry missing from the index is purged at
    // the next launch.
    indexDirty = true;
    void flushIndex();
    // Same data again: the screen keeps its snapshot (no re-render), only the date moved.
    if (changed) setState(key, { entry, error: undefined });
    else if (states.get(key)?.error) setState(key, { error: undefined });
    return changed;
  }

  /** One request per key at a time; the result is stored. */
  function revalidate<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const running = inflight.get(key);
    if (running) return running as Promise<T>;
    setState(key, { pending: true });
    const p = (async () => {
      try {
        const value = await fetcher();
        await set(key, value);
        setState(key, { pending: false, error: undefined });
        return value;
      } catch (e) {
        setState(key, { pending: false, error: e });
        throw e;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  const age = (e: SwrEntry<unknown>) => now() - e.at;

  /**
   * Cached value at once when there is one (younger than `maxStale`), refreshed in the background
   * when older than `ttl`. Without a usable entry, waits for the network.
   */
  async function swr<T>(key: string, fetcher: () => Promise<T>, opts: SwrOptions): Promise<T> {
    const e = await get<T>(key);
    if (e && age(e) <= (opts.maxStale ?? Infinity)) {
      if (opts.force || age(e) >= opts.ttl) revalidate(key, fetcher).catch(() => {});
      return e.value;
    }
    return revalidate(key, fetcher);
  }

  /** Fresh value: the cache when younger than `ttl`, else the network (the stale entry if it fails). */
  async function load<T>(key: string, fetcher: () => Promise<T>, opts: SwrOptions): Promise<T> {
    const e = await get<T>(key);
    if (e && !opts.force && age(e) < opts.ttl) return e.value;
    try {
      return await revalidate(key, fetcher);
    } catch (err) {
      if (e && age(e) <= (opts.maxStale ?? Infinity)) return e.value;
      throw err;
    }
  }

  async function remove(key: string) {
    await ready;
    memory.delete(key);
    dropFromIndex(key);
    if (states.has(key)) setState(key, { entry: undefined, error: undefined });
    persistIndex();
    await queue(() => storage.removeItem(entryKey(key)));
  }

  async function clear() {
    await ready;
    const keys = [...index.keys()];
    for (const k of keys) await remove(k);
    memory.clear();
    await flush();
  }

  /** Waits for pending storage writes (tests, before a backup). */
  async function flush() {
    if (indexTimer) {
      clearTimeout(indexTimer);
      indexTimer = undefined;
    }
    await flushIndex();
    await writes;
  }

  function subscribe(key: string, listener: () => void) {
    let set = listeners.get(key);
    if (!set) listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) listeners.delete(key);
    };
  }

  /** Snapshot for `useSyncExternalStore` (stable until the key changes). */
  function state<T>(key: string): SwrState<T> {
    const s = states.get(key);
    if (s) return s as SwrState<T>;
    const entry = memory.get(key)?.entry;
    if (!entry) return EMPTY as SwrState<T>;
    const fresh: SwrState<T> = { entry: entry as SwrEntry<T>, pending: false };
    states.set(key, fresh as SwrState<unknown>);
    return fresh;
  }

  const stats = () => ({ entries: index.size, bytes });

  return { ready, peek, get, set, swr, load, revalidate, remove, clear, flush, subscribe, state, stats, isFresh: (e: SwrEntry<unknown>, ttl: number) => age(e) < ttl };
}

export type SwrCache = ReturnType<typeof createSwrCache>;

/** FNV-1a, for cache keys built from long or private strings (add-on URLs with tokens). */
export function hashKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
