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

function resolvers(): TorrentResolver[] {
  const d = getDebrid();
  const debrid: TorrentResolver[] = d
    ? [{ id: d.provider.id, label: d.provider.name, available: () => true, resolve: (t, s) => d.provider.resolve(d.key, t, s) }]
    : [];
  return [...debrid, ...extra.filter((r) => r.available())];
}

const EMPTY: Record<string, boolean> = {};
const cache = new Map<string, { url: string; at: number }>();
const refKey = (t: TorrentRef) => `${t.infoHash.toLowerCase()}|${t.fileIdx ?? ''}|${t.filename ?? ''}`;

/** Resolves a torrent to an HTTP(S) URL. Throws when no resolver can play it. */
export async function resolveTorrent(t: TorrentRef, signal?: AbortSignal): Promise<{ url: string; via: string }> {
  const list = resolvers();
  if (!list.length) throw new DebridError('Aucun service débrid configuré');
  const hit = cache.get(refKey(t));
  // Debrid links are valid for hours; keep them 1 h.
  if (hit && Date.now() - hit.at < 3600e3) return { url: hit.url, via: list[0].label };
  let last: unknown;
  for (const r of list) {
    try {
      const url = await r.resolve(t, signal);
      cache.set(refKey(t), { url, at: Date.now() });
      return { url, via: r.label };
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new DebridError('Résolution impossible');
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
