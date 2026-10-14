// Web replacement for @react-native-async-storage/async-storage (aliased in metro.config.js for
// the web platform only). Same API, backed by IndexedDB instead of localStorage, whose ~5 MB quota
// the catalog caches, progress and lists outgrow (docs/WEB_DOCKER_PLAN.md, D19).
//
// One object store `kv` of string values keyed by string. When IndexedDB is unavailable (some
// private modes, sandboxed iframes, prerender), it degrades to an in-memory map for the session.

type Callback = (error?: Error | null) => void;
type CallbackWithResult<T> = (error?: Error | null, result?: T | null) => void;
type KeyValuePair = [string, string | null];
type MultiCallback = (errors?: readonly (Error | null)[] | null) => void;
type MultiGetCallback = (errors?: readonly (Error | null)[] | null, result?: readonly KeyValuePair[]) => void;

const DB_NAME = 'huwa-async-storage';
const STORE = 'kv';

interface Backend {
  get(keys: readonly string[]): Promise<(string | null)[]>;
  set(pairs: readonly (readonly [string, string])[]): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

function memoryBackend(): Backend {
  const map = new Map<string, string>();
  return {
    async get(keys) {
      return keys.map((k) => map.get(k) ?? null);
    },
    async set(pairs) {
      for (const [k, v] of pairs) map.set(k, v);
    },
    async remove(keys) {
      for (const k of keys) map.delete(k);
    },
    async keys() {
      return [...map.keys()];
    },
    async clear() {
      map.clear();
    },
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function idbBackend(db: IDBDatabase): Backend {
  const store = (mode: IDBTransactionMode) => {
    const tx = db.transaction(STORE, mode);
    return { tx, os: tx.objectStore(STORE) };
  };
  return {
    async get(keys) {
      const { os } = store('readonly');
      const values = await Promise.all(keys.map((k) => request(os.get(k))));
      return values.map((v) => (typeof v === 'string' ? v : null));
    },
    async set(pairs) {
      const { tx, os } = store('readwrite');
      for (const [k, v] of pairs) os.put(v, k);
      await done(tx);
    },
    async remove(keys) {
      const { tx, os } = store('readwrite');
      for (const k of keys) os.delete(k);
      await done(tx);
    },
    async keys() {
      const { os } = store('readonly');
      return (await request(os.getAllKeys())).map(String);
    },
    async clear() {
      const { tx, os } = store('readwrite');
      os.clear();
      await done(tx);
    },
  };
}

let backend: Promise<Backend> | null = null;

function open(): Promise<Backend> {
  if (backend) return backend;
  backend = (async () => {
    try {
      if (typeof indexedDB === 'undefined') throw new Error('IndexedDB unavailable');
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      const db = await request(req);
      // Another tab upgrading the schema later: let it, this tab reopens on its next call.
      db.onversionchange = () => {
        db.close();
        backend = null;
      };
      return idbBackend(db);
    } catch (err) {
      console.warn('[huwa] IndexedDB indisponible, stockage en mémoire pour cette session', err);
      return memoryBackend();
    }
  })();
  return backend;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Runs `op`, forwarding the outcome to an optional node-style callback like the real package. */
async function withCallback<T>(op: () => Promise<T>, cb?: (error?: Error | null, result?: T | null) => void): Promise<T> {
  try {
    const result = await op();
    cb?.(null, result);
    return result;
  } catch (err) {
    const error = toError(err);
    cb?.(error);
    throw error;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge of JSON objects, as the package's web `mergeItem` does. */
function merge(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = merge(base[k], v);
  return out;
}

async function mergeOne(b: Backend, key: string, value: string) {
  const [current] = await b.get([key]);
  const next = current == null ? value : JSON.stringify(merge(JSON.parse(current), JSON.parse(value)));
  await b.set([[key, next]]);
}

const AsyncStorage = {
  getItem(key: string, callback?: CallbackWithResult<string>): Promise<string | null> {
    return withCallback<string | null>(async () => (await (await open()).get([key]))[0], callback);
  },
  setItem(key: string, value: string, callback?: Callback): Promise<void> {
    return withCallback(async () => (await open()).set([[key, value]]), callback);
  },
  removeItem(key: string, callback?: Callback): Promise<void> {
    return withCallback(async () => (await open()).remove([key]), callback);
  },
  mergeItem(key: string, value: string, callback?: Callback): Promise<void> {
    return withCallback(async () => mergeOne(await open(), key, value), callback);
  },
  clear(callback?: Callback): Promise<void> {
    return withCallback(async () => (await open()).clear(), callback);
  },
  getAllKeys(callback?: CallbackWithResult<readonly string[]>): Promise<readonly string[]> {
    return withCallback(async () => (await open()).keys(), callback);
  },
  flushGetRequests(): void {},
  async multiGet(keys: readonly string[], callback?: MultiGetCallback): Promise<readonly KeyValuePair[]> {
    try {
      const values = await (await open()).get(keys);
      const result = keys.map((k, i): KeyValuePair => [k, values[i]]);
      callback?.(null, result);
      return result;
    } catch (err) {
      const error = toError(err);
      callback?.([error]);
      throw [error];
    }
  },
  async multiSet(pairs: readonly (readonly [string, string])[], callback?: MultiCallback): Promise<void> {
    try {
      await (await open()).set(pairs);
      callback?.(null);
    } catch (err) {
      const error = toError(err);
      callback?.([error]);
      throw [error];
    }
  },
  async multiRemove(keys: readonly string[], callback?: MultiCallback): Promise<void> {
    try {
      await (await open()).remove(keys);
      callback?.(null);
    } catch (err) {
      const error = toError(err);
      callback?.([error]);
      throw [error];
    }
  },
  async multiMerge(pairs: readonly (readonly [string, string])[], callback?: MultiCallback): Promise<void> {
    try {
      const b = await open();
      for (const [k, v] of pairs) await mergeOne(b, k, v);
      callback?.(null);
    } catch (err) {
      const error = toError(err);
      callback?.([error]);
      throw [error];
    }
  },
};

export function useAsyncStorage(key: string) {
  return {
    getItem: (callback?: CallbackWithResult<string>) => AsyncStorage.getItem(key, callback),
    setItem: (value: string, callback?: Callback) => AsyncStorage.setItem(key, value, callback),
    mergeItem: (value: string, callback?: Callback) => AsyncStorage.mergeItem(key, value, callback),
    removeItem: (callback?: Callback) => AsyncStorage.removeItem(key, callback),
  };
}

export default AsyncStorage;
