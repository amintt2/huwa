// Torrent → playable URL. Resolution order: the configured debrid service, then any resolver
// registered with `registerTorrentResolver` (extension point for the native torrent engine,
// phase 7c: it would return its loopback `http://127.0.0.1:…` URL).
import { useEffect, useState, useSyncExternalStore } from 'react';

import { DebridError, type TorrentRef } from './providers';
import { getDebrid, subscribeDebrid, useDebrid } from './store';

export type { TorrentRef } from './providers';

export type TorrentResolver = {
  id: string;
  /** Shown in the source list: "via <label>". */
  label: string;
  available: () => boolean;
  resolve: (t: TorrentRef, signal?: AbortSignal) => Promise<string>;
  /**
   * How long a resolved URL may be reused (default 1 h, debrid links last hours). 0 = never: the
   * native engine's loopback URL dies with its torrent (deleted, evicted, engine restarted), and
   * resolving again is cheap (it returns the running torrent).
   */
  cacheMs?: number;
};

const extra: TorrentResolver[] = [];
const listeners = new Set<() => void>();
let version = 0;

/** Plug an additional resolver (native engine). Returns an unregister function. */
export function registerTorrentResolver(r: TorrentResolver) {
  extra.push(r);
  version++;
  listeners.forEach((l) => l());
  return () => {
    const i = extra.indexOf(r);
    if (i >= 0) extra.splice(i, 1);
    version++;
    listeners.forEach((l) => l());
  };
}

/**
 * Bumped whenever the debrid account changes (provider, key, sign-out): URLs resolved with the
 * previous account are never handed out again.
 */
let account = 0;
subscribeDebrid(() => {
  account++;
});

function resolvers(): TorrentResolver[] {
  const d = getDebrid();
  const debrid: TorrentResolver[] = d
    ? [{ id: `${d.provider.id}#${account}`, label: d.provider.name, available: () => true, resolve: (t, s) => d.provider.resolve(d.key, t, s) }]
    : [];
  return [...debrid, ...extra.filter((r) => r.available())];
}

const EMPTY: Record<string, boolean> = {};
const DEFAULT_CACHE_MS = 3600e3;
const MAX_CACHE = 200;
const cache = new Map<string, { url: string; at: number }>();

/** Everything that changes which file / URL comes back: resolver (and account), torrent, file, episode. */
export const resolveCacheKey = (resolverId: string, t: TorrentRef) =>
  JSON.stringify([resolverId, t.infoHash.toLowerCase(), t.fileIdx ?? null, t.filename ?? null, t.episode ?? null]);

function cached(r: TorrentResolver, t: TorrentRef): string | undefined {
  const ttl = r.cacheMs ?? DEFAULT_CACHE_MS;
  if (ttl <= 0) return undefined;
  const key = resolveCacheKey(r.id, t);
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at < ttl) return hit.url;
  cache.delete(key);
  return undefined;
}

async function resolveWith(r: TorrentResolver, t: TorrentRef, signal?: AbortSignal): Promise<string> {
  const url = await r.resolve(t, signal);
  if ((r.cacheMs ?? DEFAULT_CACHE_MS) > 0) {
    cache.set(resolveCacheKey(r.id, t), { url, at: Date.now() });
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  }
  return url;
}

/** Resolves a torrent to an HTTP(S) URL. Throws when no resolver can play it. */
export async function resolveTorrent(t: TorrentRef, signal?: AbortSignal): Promise<{ url: string; via: string }> {
  const list = resolvers();
  if (!list.length) throw new DebridError('Aucun service débrid configuré');
  for (const r of list) {
    const url = cached(r, t);
    if (url) return { url, via: r.label };
  }
  let last: unknown;
  for (const r of list) {
    try {
      return { url: await resolveWith(r, t, signal), via: r.label };
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new DebridError('Résolution impossible');
}

/**
 * Debrid service only (never the on-device engine, which would start a torrent download): used
 * to measure cached torrents in the source race. Null when no debrid service is configured.
 */
export async function resolveTorrentViaDebrid(t: TorrentRef, signal?: AbortSignal): Promise<{ url: string; via: string } | null> {
  if (!getDebrid()) return null;
  const r = resolvers()[0]; // the debrid service comes first
  return { url: cached(r, t) ?? (await resolveWith(r, t, signal)), via: r.label };
}

/** Label of the first resolver ("TorBox"), or null when torrents cannot be played. */
export function useTorrentResolver(): string | null {
  const { provider } = useDebrid();
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => version,
  );
  return provider?.name ?? extra.find((r) => r.available())?.label ?? null;
}

/** Instant-availability map (hash → cached) when the provider supports it. */
export function useCachedHashes(hashes: string[]): Record<string, boolean> {
  const key = hashes.map((h) => h.toLowerCase()).sort().join(',');
  const [res, setRes] = useState<{ key: string; map: Record<string, boolean> }>({ key: '', map: {} });
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeDebrid(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    const d = getDebrid();
    if (!key || !d?.provider.checkCached) return;
    let cancelled = false;
    const list = key.split(',');
    const chunks: string[][] = [];
    for (let i = 0; i < list.length; i += 50) chunks.push(list.slice(i, i + 50));
    Promise.all(chunks.map((c) => d.provider.checkCached!(d.key, c).catch(() => ({}))))
      .then((maps) => {
        if (!cancelled) setRes({ key: `${key}#${tick}`, map: Object.assign({}, ...maps) });
      });
    return () => {
      cancelled = true;
    };
  }, [key, tick]);
  return res.key === `${key}#${tick}` ? res.map : EMPTY;
}
