// AniList ↔ Kitsu / MAL / IMDb id mapping.
// Primary source: ARM (https://arm.haglund.dev, open source, no key), built from Fribb/anime-lists.
//   GET /api/v2/ids?source=anilist&id=154587 → { anilist, kitsu, myanimelist, imdb, thetvdb-season, media, … }
//   GET /api/v2/ids?source=kitsu&id=12, GET /api/v2/imdb?id=tt… (array)
// Fallback for Kitsu only: Kitsu's own mappings API
//   GET https://kitsu.app/api/edge/mappings?filter[externalSite]=anilist/anime&filter[externalId]=21
// Results are cached in AsyncStorage (hits 30 days, misses 1 day).
// Episode offsets of split-cour shows (TheTVDB / TMDB numbering) come from ./episode-map.ts.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

import { episodeMapping } from './episode-map';
import { getJson } from './protocol';

export type AnimeIds = {
  anilist: number;
  kitsu?: number;
  mal?: number;
  imdb?: string;
  /** Season number of this entry on TheTVDB/IMDb (split-cour shows), when known. */
  season?: number;
  anidb?: number;
  /**
   * Added to our episode number for IMDb/TheTVDB numbering inside `season` (split-cour shows:
   * "Part 2" ep. 1 = S1E13). Filled by `idsForAnilist` from the Fribb mapping, not cached here.
   */
  epOffset?: number;
  /** Second IMDb numbering to try (TMDB's, often absolute): season + offset. */
  alt?: { season: number; offset: number };
  /** "TV", "MOVIE", "OVA"… */
  media?: string;
};

type ArmEntry = {
  anidb?: number | null;
  anilist?: number | null;
  kitsu?: number | null;
  myanimelist?: number | null;
  imdb?: string | null;
  'thetvdb-season'?: number | null;
  'themoviedb-season'?: number | null;
  media?: string | null;
};

const ARM = 'https://arm.haglund.dev/api/v2';
const KITSU = 'https://kitsu.app/api/edge';
const CACHE_KEY = 'huwa/ids/v2';
const HIT_TTL = 30 * 86400e3;
const MISS_TTL = 86400e3;

type CacheEntry = { at: number; ids: AnimeIds | null };
let cache: Record<string, CacheEntry> | null = null;
const inflight = new Map<string, Promise<AnimeIds | null>>();

async function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse((await AsyncStorage.getItem(CACHE_KEY)) ?? '{}') as Record<string, CacheEntry>;
  } catch {
    cache = {};
  }
  return cache;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (cache) AsyncStorage.setItem(CACHE_KEY, JSON.stringify(cache)).catch(() => {});
  }, 500);
}

const fromArm = (e: ArmEntry | null | undefined): AnimeIds | null =>
  e?.anilist
    ? {
        anilist: e.anilist,
        kitsu: e.kitsu ?? undefined,
        mal: e.myanimelist ?? undefined,
        imdb: e.imdb && /^tt\d+$/.test(e.imdb) ? e.imdb : undefined,
        season: e['thetvdb-season'] ?? e['themoviedb-season'] ?? undefined,
        anidb: e.anidb ?? undefined,
        media: e.media ?? undefined,
      }
    : null;

async function kitsuFallback(anilist: number): Promise<AnimeIds | null> {
  const res = await getJson<{ data?: { relationships?: { item?: { data?: { type: string; id: string } } } }[] }>(
    `${KITSU}/mappings?filter[externalSite]=anilist/anime&filter[externalId]=${anilist}&include=item`,
  );
  const item = res.data?.[0]?.relationships?.item?.data;
  return item?.type === 'anime' ? { anilist, kitsu: Number(item.id) } : null;
}

async function cached(key: string, load: () => Promise<AnimeIds | null>): Promise<AnimeIds | null> {
  const c = await loadCache();
  const hit = c[key];
  if (hit && Date.now() - hit.at < (hit.ids ? HIT_TTL : MISS_TTL)) return hit.ids;
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = load()
    .then((ids) => {
      c[key] = { at: Date.now(), ids };
      if (ids) c[`anilist:${ids.anilist}`] ??= { at: Date.now(), ids };
      save();
      return ids;
    })
    .catch(() => hit?.ids ?? null) // offline: stale entry is better than nothing, and misses are not cached
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/**
 * ARM ids of an AniList anime already in the cache (stale ones too), without the episode
 * offsets: undefined when not cached or the cache is not loaded yet (`loadIdsCache`).
 */
export function peekIds(anilist: number): AnimeIds | null | undefined {
  return cache?.[`anilist:${anilist}`]?.ids;
}

/** Loads the ids cache from disk (once). */
export const loadIdsCache = (): Promise<void> => loadCache().then(() => {});

/** Adds the episode offsets of split-cour shows (see ./episode-map.ts). */
export async function withEpisodeMapping(ids: AnimeIds | null): Promise<AnimeIds | null> {
  if (!ids?.anidb || ids.media === 'MOVIE') return ids;
  const m = await episodeMapping(ids.anidb).catch(() => null);
  if (!m) return ids;
  const season = m.tvdbSeason ?? ids.season;
  const out: AnimeIds = { ...ids, season, epOffset: m.tvdbOffset };
  // TMDB numbering differing from TheTVDB's (e.g. Re:Zero S4 = TMDB S1 + 66): second guess.
  if (m.tmdbSeason && (m.tmdbSeason !== (season ?? 1) || (m.tmdbOffset ?? 0) !== (m.tvdbOffset ?? 0))) {
    out.alt = { season: m.tmdbSeason, offset: m.tmdbOffset ?? 0 };
  }
  return out;
}

/** External ids for an AniList anime id, with episode offsets. */
export async function idsForAnilist(anilist: number): Promise<AnimeIds | null> {
  return withEpisodeMapping(await armIdsForAnilist(anilist));
}

function armIdsForAnilist(anilist: number): Promise<AnimeIds | null> {
  return cached(`anilist:${anilist}`, async () => {
    try {
      const ids = fromArm(await getJson<ArmEntry>(`${ARM}/ids?source=anilist&id=${anilist}`));
      if (ids) return ids;
    } catch {
      // ARM down: try Kitsu below
    }
    return kitsuFallback(anilist);
  });
}

/** Reverse mapping, for catalog items coming from addons (`kitsu:12`, `tt0388629`, `mal:21`, `anilist:21`). */
export function idsForStremioId(stremioId: string): Promise<AnimeIds | null> {
  const [head, second] = stremioId.split(':');
  if (head === 'anilist' && Number(second)) return idsForAnilist(Number(second));
  if (head === 'kitsu' && Number(second))
    return cached(`kitsu:${second}`, async () => fromArm(await getJson<ArmEntry>(`${ARM}/ids?source=kitsu&id=${second}`)));
  if (head === 'mal' && Number(second))
    return cached(`mal:${second}`, async () => fromArm(await getJson<ArmEntry>(`${ARM}/ids?source=myanimelist&id=${second}`)));
  if (/^tt\d+$/.test(head))
    return cached(`imdb:${head}`, async () => {
      // One IMDb id covers every season: take the first season / TV entry.
      const list = await getJson<ArmEntry[]>(`${ARM}/imdb?id=${head}`);
      // Prefer the TV series over OVAs/specials (TheTVDB season 0), then the earliest season.
      const rank = (e: ArmEntry) => (e.media === 'TV' ? 0 : 1000) + (e['thetvdb-season'] || 99);
      const best = [...list].sort((a, b) => rank(a) - rank(b))[0];
      return fromArm(best);
    });
  return Promise.resolve(null);
}

/** `al154587` (our catalog id) → 154587. Demo series have no AniList id. */
export const anilistNumber = (seriesId: string) => {
  const m = /^al(\d+)$/.exec(seriesId);
  return m ? Number(m[1]) : null;
};

/** Hook: ids for one of our series; `undefined` while loading, `null` when unknown. */
export function useAnimeIds(seriesId: string) {
  const anilist = anilistNumber(seriesId);
  const [res, setRes] = useState<{ key: string; ids: AnimeIds | null }>({ key: '', ids: null });
  useEffect(() => {
    if (anilist == null) return;
    let cancelled = false;
    idsForAnilist(anilist).then((ids) => {
      if (!cancelled) setRes({ key: seriesId, ids });
    });
    return () => {
      cancelled = true;
    };
  }, [anilist, seriesId]);
  if (anilist == null) return null;
  return res.key === seriesId ? res.ids : undefined;
}
