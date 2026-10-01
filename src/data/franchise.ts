// Earlier seasons of an AniList anime, found by walking its PREQUEL relations. Each AniList
// season is its own series in Huwa (`al<id>`), so a trending "Season 3" needs this to start the
// show from the beginning. Resolved lazily (only for what is on screen), cached and persisted.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

import { isDemo } from '@/demo/flags';
import { DEMO_CHAINS } from '@/demo/seasons';
import { getState, useStore } from '@/store/store';

import { isTvLike, NODE, prequelOf, type Media } from './anilist';
import { gql, seriesFromMedia } from './anilist-api';
import { getSeries, refreshCatalog, registerSeries, useCatalog, type Series } from './catalog';
import { playTarget, type PlayTarget } from './play-target';

const KEY = 'huwa/franchise/v1';
const MAX_HOPS = 8;

/** series id → ids of its earlier seasons, first season first. */
let chains: Record<string, string[]> = {};
let loaded: Promise<void> | null = null;
const inflight = new Map<string, Promise<string[]>>();
/** Resolution failed this session (offline, rate limit): play the series itself. */
const failed = new Set<string>();

const anilistId = (s: Series) => (/^al\d+$/.test(s.id) ? Number(s.id.slice(2)) : null);

function load() {
  loaded ??= AsyncStorage.getItem(KEY)
    .then((raw) => {
      if (!raw) return;
      chains = { ...JSON.parse(raw), ...chains };
      // Chapter ranges of later seasons start after their prequels (data/mapping-overlay.ts).
      refreshCatalog();
    })
    .catch(() => {});
  return loaded;
}

/** Restore the persisted chains at launch, so later seasons show their chapters right away. */
export const loadFranchise = () => load();

/** Ids of the earlier seasons, first season first (synchronous, undefined while unknown). */
export function prequelIdsOf(id: string): string[] | undefined {
  if (isDemo) return DEMO_CHAINS[id] ?? [];
  return chains[id];
}

/** Earlier seasons when known (possibly none), undefined while they still have to be fetched. */
export function knownPrequels(s: Series): Series[] | undefined {
  if (isDemo) return (DEMO_CHAINS[s.id] ?? []).map(getSeries).filter((x): x is Series => !!x);
  if (anilistId(s) === null || s.prequel === null || failed.has(s.id)) return [];
  const ids = chains[s.id];
  if (!ids) return undefined;
  const list = ids.map(getSeries);
  // A season dropped from the registry (evicted): fetch the chain again.
  return list.every(Boolean) ? (list as Series[]) : undefined;
}

const QUERY = `query ($id: Int) { Media(id: $id) { ${NODE} relations { edges { relationType(version: 2) node { ${NODE} } } } } }`;
const fetchMedia = async (id: number) => (await gql<{ Media: Media }>(QUERY, { id })).Media;

async function walk(s: Series): Promise<string[]> {
  await load();
  const known = knownPrequels(s);
  if (known) return known.map((x) => x.id);
  const self = anilistId(s)!;
  let next = s.prequel === undefined ? (prequelOf(await fetchMedia(self))?.id ?? null) : s.prequel;
  const seen = new Set([self]);
  const found: Series[] = [];
  for (let hop = 0; hop < MAX_HOPS && next != null && !seen.has(next); hop++) {
    seen.add(next);
    const m = await fetchMedia(next);
    if (m.type === 'ANIME' && isTvLike(m)) {
      const season = getSeries(`al${m.id}`) ?? seriesFromMedia(m);
      if (season?.anime) found.unshift(season);
    }
    next = prequelOf(m)?.id ?? null;
  }
  const fresh = found.filter((x) => !getSeries(x.id));
  if (fresh.length) registerSeries(fresh);
  const ids = found.map((x) => x.id);
  chains[s.id] = ids;
  // Every season of the chain knows its own prequels too (no extra request for them).
  ids.forEach((id, i) => {
    chains[id] ??= ids.slice(0, i);
  });
  AsyncStorage.setItem(KEY, JSON.stringify(chains)).catch(() => {});
  refreshCatalog();
  return chains[s.id];
}

/** Fetch (once) the earlier seasons of a series. Never rejects: failures fall back to the series alone. */
export function resolvePrequels(s: Series): Promise<string[]> {
  let p = inflight.get(s.id);
  if (!p) {
    p = walk(s).catch(() => {
      failed.add(s.id);
      return [];
    });
    inflight.set(s.id, p);
    p.finally(() => inflight.delete(s.id));
  }
  return p;
}

/** Episode to open for a series and its whole franchise, with the label that goes with it. */
export function franchiseTarget(s: Series, watched = getState().episodes): PlayTarget | undefined {
  const prequels = knownPrequels(s);
  return playTarget([...(prequels ?? []), s], watched);
}

/**
 * Play target for a series. While earlier seasons are unknown and the user has never watched
 * this one, `pending` is true (label "Regarder", the press waits for the resolution).
 * `active`: only fetch for the slide that is on screen.
 */
export function useFranchiseTarget(s: Series, active: boolean) {
  const watched = useStore((st) => st.episodes);
  const catalogVersion = useCatalog();
  const [, setTick] = useState(0);
  const prequels = knownPrequels(s);
  const unknown = prequels === undefined;

  useEffect(() => {
    if (!active || !unknown) return;
    let alive = true;
    // Persisted chains first: no request at all for anything seen before.
    load().then(() => resolvePrequels(s)).then(() => alive && setTick((n) => n + 1));
    return () => {
      alive = false;
    };
  }, [active, unknown, s, catalogVersion]);

  const watchedSelf = s.anime?.episodes.some((e) => watched[e.id]) ?? false;
  const target = unknown && !watchedSelf ? undefined : playTarget([...(prequels ?? []), s], watched);
  return { target, pending: unknown && !watchedSelf, seasonNumber: prequels ? prequels.length + 1 : undefined };
}

/** Season number of a series inside its franchise (1 = first), once its prequels are known. */
export function useSeasonNumber(s: Series, active = true): number | undefined {
  const [, setTick] = useState(0);
  const prequels = knownPrequels(s);
  const unknown = prequels === undefined;
  useEffect(() => {
    if (!active || !unknown) return;
    let alive = true;
    load().then(() => resolvePrequels(s)).then(() => alive && setTick((n) => n + 1));
    return () => {
      alive = false;
    };
  }, [active, unknown, s]);
  return prequels ? prequels.length + 1 : undefined;
}

/** Episode 1 of the franchise's first season (fetches the prequels if needed). */
export async function firstEpisodeOf(s: Series) {
  await load();
  await resolvePrequels(s);
  const first = knownPrequels(s)?.[0] ?? s;
  return first.anime?.episodes[0] ?? s.anime?.episodes[0];
}
