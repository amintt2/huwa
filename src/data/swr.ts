// The app's persisted stale-while-revalidate cache (./swr-core.ts on AsyncStorage — IndexedDB on
// the web) and its React hook. Every screen that shows remote data reads through it: cached data
// on the first frame, a background refresh when it is stale, a re-render only when it changed.
import { useEffect, useState, useSyncExternalStore } from 'react';

import AsyncStorage from '@react-native-async-storage/async-storage';

import { createSwrCache, type SwrOptions, type SwrState } from './swr-core';

/** Bump to drop every cached entry (shape of a cached value changed). */
export const SWR_VERSION = 1;
export const SWR_PREFIX = 'huwa/swr/';

export const cache = createSwrCache({
  storage: AsyncStorage,
  prefix: SWR_PREFIX,
  version: SWR_VERSION,
  maxEntries: 600,
  // Catalog (~0.5 MB with long-running shows), calendar weeks, browse pages, details…
  maxBytes: 12 * 1024 * 1024,
});

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Refresh age and "too old to show" age per kind of data. */
export const TTL = {
  /** Trending catalog (home, tabs): changes through the day. */
  catalog: { ttl: 15 * MIN, maxStale: 30 * DAY },
  /** Airing calendar of a week: times move rarely, new entries appear. */
  calendar: { ttl: 30 * MIN, maxStale: 7 * DAY },
  /** Browse / section pages (Anime tab, "Voir tout"). */
  browse: { ttl: 30 * MIN, maxStale: 3 * DAY },
  /** Search results (same filters again: instant, refreshed). */
  search: { ttl: 10 * MIN, maxStale: 2 * DAY },
  /** A series opened from search / calendar / a link: scores and episode counts. */
  series: { ttl: 12 * HOUR, maxStale: 90 * DAY },
  /** First page of an add-on catalog. */
  addon: { ttl: 30 * MIN, maxStale: 7 * DAY },
  /** Home sections of a manga source (each refresh wakes its sandbox). */
  source: { ttl: 30 * MIN, maxStale: 7 * DAY },
} satisfies Record<string, SwrOptions>;

const EMPTY: SwrState<never> = { pending: false };
const noop = () => () => {};

export type SwrResult<T> = {
  data: T | undefined;
  /** Nothing to show yet: a skeleton. */
  loading: boolean;
  /** A background refresh is running over shown data. */
  refreshing: boolean;
  error: unknown;
  /** Force a refresh (pull to refresh, "Réessayer"). */
  reload: () => void;
};

/**
 * Data for `key` (null: nothing to load). First frame: the in-memory entry when there is one;
 * then the disk entry, then the network when it is stale. Re-renders only when the data changed.
 */
export function useSwr<T>(key: string | null, fetcher: () => Promise<T>, opts: SwrOptions): SwrResult<T> {
  const [nonce, setNonce] = useState(0);
  const state = useSyncExternalStore(
    key ? (l) => cache.subscribe(key, l) : noop,
    () => (key ? cache.state<T>(key) : (EMPTY as SwrState<T>)),
    () => (key ? cache.state<T>(key) : (EMPTY as SwrState<T>)),
  );
  // Disk hit or first request settled: stops showing a skeleton when the request failed.
  const [settled, setSettled] = useState<string | null>(null);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    cache
      .swr(key, fetcher, nonce ? { ...opts, force: true } : opts)
      .catch(() => {})
      .finally(() => alive && setSettled(key));
    return () => {
      alive = false;
    };
    // `fetcher` and `opts` are described by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  const data = state.entry?.value;
  return {
    data,
    loading: !!key && data === undefined && !(settled === key && !state.pending),
    refreshing: data !== undefined && state.pending,
    error: state.error,
    reload: () => setNonce((n) => n + 1),
  };
}
