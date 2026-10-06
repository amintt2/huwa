// Full airing schedule of a season still airing (AniList `airingSchedule(notYetAired: true)`, every
// page up to the season's announced total), for the anime page's upcoming rows and bells.
// Cached and persisted: refreshed when the page gets focus and the copy is over an hour old,
// and the page keeps working offline from the last copy. The schedule also sets how many
// episodes are out in the catalog (data/catalog.ts `setAiredCounts`), so an episode that airs
// while the page is open becomes a normal playable row.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { isDemo } from '@/demo/flags';
import { anilistIdOf } from '@/notifications/plan';

import { airedFromSchedule, mergeSchedule, type AiringNode } from './airing';
import { gql } from './anilist-api';
import { getSeries, setAiredCounts, type Series } from './catalog';

const KEY = 'huwa/upcoming/v1';
/** Older than this, the schedule is fetched again when the page gets focus. */
export const STALE_MS = 3_600_000;
const PER_PAGE = 25;
const MAX_PAGES = 12;
const MAX_ENTRIES = 80;
/** A schedule whose episodes all aired is kept this long (offline aired count), then dropped. */
const KEEP_AIRED_MS = 21 * 86_400_000;

export type ScheduleEntry = {
  fetchedAt: number;
  /** Announced episode count of the season, null while unknown. */
  total: number | null;
  /** Episodes not aired yet when fetched, by episode. */
  nodes: AiringNode[];
};

let entries: Record<string, ScheduleEntry> = {};
let loaded: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<void>>();

function emit() {
  version++;
  listeners.forEach((l) => l());
}

/** Episodes out per cached season, pushed to the catalog (only seasons with a schedule). */
function applyAired(ids: string[], now = Date.now()) {
  const counts: Record<string, number> = {};
  for (const id of ids) {
    const e = entries[id];
    if (e?.nodes.length) counts[id] = airedFromSchedule(e.total, e.nodes, now);
  }
  setAiredCounts(counts);
}

function persist() {
  const now = Date.now();
  const keep = Object.entries(entries)
    .filter(([, e]) => e.nodes.some((n) => n.airingAt * 1000 > now) || now - e.fetchedAt < KEEP_AIRED_MS)
    .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
    .slice(0, MAX_ENTRIES);
  entries = Object.fromEntries(keep);
  AsyncStorage.setItem(KEY, JSON.stringify(entries)).catch(() => {});
}

/** Restore the cached schedules (once) and the aired counts they give. */
export function loadUpcoming() {
  loaded ??= AsyncStorage.getItem(KEY)
    .then((raw) => {
      if (!raw) return;
      entries = { ...JSON.parse(raw), ...entries };
      applyAired(Object.keys(entries));
      emit();
    })
    .catch(() => {});
  return loaded;
}

/** Cached schedule of a series (synchronous, after `loadUpcoming`). */
export const cachedSchedule = (seriesId: string): ScheduleEntry | undefined => entries[seriesId];

const QUERY = `query ($id: Int, $page: Int) { Media(id: $id, type: ANIME) { episodes
  airingSchedule(notYetAired: true, page: $page, perPage: ${PER_PAGE}) { pageInfo { hasNextPage } nodes { episode airingAt } } } }`;

type ScheduleData = {
  Media: { episodes: number | null; airingSchedule: { pageInfo: { hasNextPage: boolean }; nodes: AiringNode[] } } | null;
};

/** Every not-yet-aired episode of an AniList anime, up to its announced total. */
export async function fetchSchedule(anilistId: number): Promise<Omit<ScheduleEntry, 'fetchedAt'>> {
  let total: number | null = null;
  const nodes: AiringNode[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const d = await gql<ScheduleData>(QUERY, { id: anilistId, page });
    if (!d.Media) break;
    total = d.Media.episodes;
    nodes.push(...d.Media.airingSchedule.nodes);
    if (!d.Media.airingSchedule.pageInfo.hasNextPage) break;
    if (total && nodes.some((n) => n.episode >= total!)) break;
  }
  return { total, nodes: mergeSchedule(nodes).filter((n) => !total || n.episode <= total) };
}

/** Fetch the schedule again (one request chain per series at a time). Failures keep the cache. */
export function refreshSchedule(seriesId: string): Promise<void> {
  const id = anilistIdOf(seriesId);
  if (id === null || isDemo) return Promise.resolve();
  let p = inflight.get(seriesId);
  if (!p) {
    p = fetchSchedule(id)
      .then((r) => {
        entries = { ...entries, [seriesId]: { ...r, fetchedAt: Date.now() } };
        applyAired([seriesId]);
        persist();
        emit();
      })
      .catch(() => {});
    inflight.set(seriesId, p);
    p.finally(() => inflight.delete(seriesId));
  }
  return p;
}

const isStale = (seriesId: string, now = Date.now()) => {
  const e = entries[seriesId];
  return !e || now - e.fetchedAt > STALE_MS;
};

/** A season with episodes still to air (or that may have some: status unknown in old caches). */
export const isAiringSeries = (s: Series) => anilistIdOf(s.id) !== null && (s.status === 'ongoing' || !!s.nextAiring);

/**
 * Cached schedule of a series still airing, refreshed whenever the screen gets focus (or the
 * app comes back) and the copy is over an hour old. Undefined while unknown or not airing.
 */
export function useUpcomingSchedule(series: Series | undefined): ScheduleEntry | undefined {
  const seriesId = series?.id;
  const airing = !!series && isAiringSeries(series);
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => version,
  );

  useFocusEffect(
    useCallback(() => {
      if (!airing || !seriesId) return;
      const check = () => {
        void loadUpcoming().then(() => {
          if (isStale(seriesId)) void refreshSchedule(seriesId);
        });
      };
      check();
      const sub = AppState.addEventListener('change', (st) => st === 'active' && check());
      return () => sub.remove();
    }, [airing, seriesId]),
  );

  return airing && seriesId ? entries[seriesId] : undefined;
}

/** setTimeout's limit (~24.8 days): longer waits are re-armed. */
const MAX_TIMER = 2_147_483_647;

/**
 * Current time, updated only when the next of `airingTimes` (unix seconds) passes: the page
 * re-renders once per airing, not every second.
 */
export function useAiringNow(airingTimes: readonly number[]): number {
  const [now, setNow] = useState(() => Date.now());
  const next = airingTimes.map((t) => t * 1000).filter((t) => t > now).sort((a, b) => a - b)[0];
  useEffect(() => {
    if (next === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(MAX_TIMER, Math.max(0, next - Date.now()) + 500));
    return () => clearTimeout(timer);
  }, [next, now]);
  return now;
}

/** Episodes out now for a cached season, pushed to the catalog (the page calls it as episodes air). */
export const refreshAired = (seriesId: string, now = Date.now()) => applyAired([seriesId], now);

/** Make sure an episode that just aired is listed (opened from its notification). */
export function ensureAired(seriesId: string, episode: number) {
  const listed = getSeries(seriesId)?.anime?.episodes.length;
  if (listed !== undefined && episode > listed) setAiredCounts({ [seriesId]: episode });
}
