// Seasons of an AniList anime, found by walking its PREQUEL / SEQUEL relations. Each AniList
// season is its own series in Huwa (`al<id>`), so a trending "Season 3" needs this to start the
// show from the beginning (prequels), and the detail page's season picker needs the whole chain.
// Resolved lazily (only for what is on screen), cached and persisted.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

import { isDemo } from '@/demo/flags';
import { DEMO_CHAINS } from '@/demo/seasons';
import { getState, useStore } from '@/store/store';

import { NODE, type Media } from './anilist';
import { gql, seriesFromMedia } from './anilist-api';
import { franchiseChain, prequelOf, walkRelation } from './anilist-relations';
import { getSeries, refreshCatalog, registerSeries, useCatalog, type Series } from './catalog';
import { playTarget, type PlayTarget } from './play-target';

const KEY = 'huwa/franchise/v1';
/** Whole chains (prequels + sequels), separate key: the prequel chains above stay compatible. */
const SEASONS_KEY = 'huwa/franchise/seasons/v1';

/** series id → ids of its earlier seasons, first season first. */
let chains: Record<string, string[]> = {};
/** series id → ids of every season of its franchise (itself included), first season first. */
let seasons: Record<string, string[]> = {};
let loaded: Promise<void> | null = null;
const inflight = new Map<string, Promise<string[]>>();
const seasonsInflight = new Map<string, Promise<string[]>>();
/** Resolution failed this session (offline, rate limit): play the series itself. */
const failed = new Set<string>();
/** Whole-chain resolution failed this session: the picker shows the series alone. */
const seasonsFailed = new Set<string>();

const anilistId = (s: Series) => (/^al\d+$/.test(s.id) ? Number(s.id.slice(2)) : null);

function load() {
  loaded ??= Promise.all([
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (!raw) return;
        chains = { ...JSON.parse(raw), ...chains };
        // Chapter ranges of later seasons start after their prequels (data/mapping-overlay.ts).
        refreshCatalog();
      })
      .catch(() => {}),
    AsyncStorage.getItem(SEASONS_KEY)
      .then((raw) => {
        if (raw) seasons = { ...JSON.parse(raw), ...seasons };
      })
      .catch(() => {}),
  ]).then(() => {});
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
/** Recent fetches, shared by the prequel and whole-chain walks (both run on the detail page). */
const media = new Map<number, Promise<Media>>();
function fetchMedia(id: number): Promise<Media> {
  let p = media.get(id);
  if (!p) {
    p = gql<{ Media: Media }>(QUERY, { id }).then((r) => r.Media);
    media.set(id, p);
    p.catch(() => media.delete(id));
    while (media.size > 48) media.delete(media.keys().next().value!);
  }
  return p;
}

/** Catalog series of fetched seasons (the registered one when known), unwatchable ones dropped. */
const toSeasons = (list: Media[]) =>
  list.map((m) => getSeries(`al${m.id}`) ?? seriesFromMedia(m)).filter((x): x is Series => !!x?.anime);

async function walk(s: Series): Promise<string[]> {
  await load();
  const known = knownPrequels(s);
  if (known) return known.map((x) => x.id);
  const self = anilistId(s)!;
  const next = s.prequel === undefined ? (prequelOf(await fetchMedia(self))?.id ?? null) : s.prequel;
  const found = toSeasons((await walkRelation(next, prequelOf, fetchMedia, new Set([self]))).reverse());
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

// ---------- whole franchise (season picker) ----------

/** Demo: the chain of DEMO_CHAINS that contains the series (the longest one), else itself. */
function demoSeasonIds(id: string): string[] {
  let best = [id];
  for (const [last, before] of Object.entries(DEMO_CHAINS)) {
    const ids = [...before, last];
    if (ids.includes(id) && ids.length > best.length) best = ids;
  }
  return best;
}

/**
 * Every season of the franchise (the series itself included, first season first) when known,
 * undefined while it still has to be fetched. Series outside AniList are their own franchise.
 */
export function knownSeasons(s: Series): Series[] | undefined {
  const pick = (ids: string[]) => ids.map((id) => (id === s.id ? s : getSeries(id)));
  if (isDemo) return pick(demoSeasonIds(s.id)).filter((x): x is Series => !!x);
  if (anilistId(s) === null || seasonsFailed.has(s.id)) return [s];
  const ids = seasons[s.id];
  if (!ids?.includes(s.id)) return undefined;
  const list = pick(ids);
  // A season dropped from the registry (evicted): fetch the chain again.
  return list.every(Boolean) ? (list as Series[]) : undefined;
}

async function walkSeasons(s: Series): Promise<string[]> {
  await load();
  const known = knownSeasons(s);
  if (known) return known.map((x) => x.id);
  // Prequels first (shared with the play button, often already known): only the sequels are left.
  await resolvePrequels(s);
  const before = failed.has(s.id) ? undefined : knownPrequels(s);
  const chain = await franchiseChain(anilistId(s)!, fetchMedia, { prequels: !before });
  if (!chain.ok) throw new Error('franchise unavailable');
  const list = [...(before ?? toSeasons(chain.before)), s, ...toSeasons(chain.after)];
  const fresh = list.filter((x) => !getSeries(x.id));
  if (fresh.length) registerSeries(fresh);
  const ids = list.map((x) => x.id);
  // Every season of the chain shares it, and knows its own prequels (no extra request for them).
  ids.forEach((id, i) => {
    seasons[id] = ids;
    if (id === s.id && !before) chains[id] = ids.slice(0, i);
    else chains[id] ??= ids.slice(0, i);
  });
  AsyncStorage.setItem(SEASONS_KEY, JSON.stringify(seasons)).catch(() => {});
  AsyncStorage.setItem(KEY, JSON.stringify(chains)).catch(() => {});
  refreshCatalog();
  return ids;
}

/** Fetch (once) every season of a series' franchise. Never rejects: failures give the series alone. */
export function resolveSeasons(s: Series): Promise<string[]> {
  let p = seasonsInflight.get(s.id);
  if (!p) {
    p = walkSeasons(s).catch(() => {
      seasonsFailed.add(s.id);
      return [s.id];
    });
    seasonsInflight.set(s.id, p);
    p.finally(() => seasonsInflight.delete(s.id));
  }
  return p;
}

/**
 * Seasons of the franchise of `s` and its position among them, undefined while loading (the
 * season picker stays hidden until then).
 */
export function useFranchiseSeasons(s: Series | undefined): { seasons: Series[]; index: number } | undefined {
  const catalogVersion = useCatalog();
  const [, setTick] = useState(0);
  const known = s ? knownSeasons(s) : undefined;
  const unknown = !!s && known === undefined;

  useEffect(() => {
    if (!s || !unknown) return;
    let alive = true;
    load().then(() => resolveSeasons(s)).then(() => alive && setTick((n) => n + 1));
    return () => {
      alive = false;
    };
  }, [unknown, s, catalogVersion]);

  if (!s || !known) return undefined;
  return { seasons: known, index: Math.max(0, known.findIndex((x) => x.id === s.id)) };
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
