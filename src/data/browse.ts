// Anime catalog browsing (Anime tab sections, "Voir tout", filters): AniList pages with a memory +
// disk cache (30 min fresh, served stale up to a day when the network fails), and the local
// catalog filtered the same way in demo mode / offline. Queries: ./browse-query.ts.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';

import { isDemo } from '@/demo/flags';

import { gql, openMedia } from './anilist-api';
import { buildAiredQuery, buildBrowseQuery, filterLocal, filtersKey, type BrowseFilters } from './browse-query';
import { allSeries, getSeries, type Palette } from './catalog';
import { palette } from './anilist';

export type BrowseItem = {
  key: string;
  title: string;
  image?: string;
  palette: Palette;
  /** 0–10, one decimal. */
  score: number | null;
  year: number | null;
  /** "Ép. 7", "Film", "À venir"… */
  badge?: string;
  /** Catalog series id when known (opens directly), else the AniList id (fetched on open). */
  seriesId?: string;
  anilistId?: number;
};

type Light = {
  id: number;
  format: string | null;
  status: string | null;
  seasonYear: number | null;
  startDate: { year: number | null } | null;
  episodes: number | null;
  averageScore: number | null;
  title: { english: string | null; userPreferred: string };
  coverImage: { large: string; color: string | null };
  nextAiringEpisode: { episode: number; airingAt: number } | null;
};

const PER_PAGE = 30;
const FRESH_MS = 30 * 60e3;
const STALE_MS = 24 * 3600e3;
const DISK_PREFIX = 'huwa/browse/v1/';

const toItem = (m: Light, badge?: string): BrowseItem => ({
  key: `al${m.id}`,
  title: m.title.english ?? m.title.userPreferred,
  image: m.coverImage.large,
  palette: getSeries(`al${m.id}`)?.palette ?? palette(m.coverImage.color),
  score: m.averageScore ? Math.round(m.averageScore) / 10 : null,
  year: m.seasonYear ?? m.startDate?.year ?? null,
  badge: badge ?? (m.format === 'MOVIE' ? 'Film' : m.status === 'NOT_YET_RELEASED' ? 'À venir' : undefined),
  seriesId: getSeries(`al${m.id}`) ? `al${m.id}` : undefined,
  anilistId: m.id,
});

export type BrowsePage = { items: BrowseItem[]; hasNext: boolean };

const memory = new Map<string, { at: number; page: BrowsePage }>();

async function cached(key: string, load: () => Promise<BrowsePage>): Promise<BrowsePage> {
  const hit = memory.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.page;
  let disk: { at: number; page: BrowsePage } | undefined;
  if (!hit) {
    try {
      const raw = await AsyncStorage.getItem(DISK_PREFIX + key);
      disk = raw ? JSON.parse(raw) : undefined;
    } catch {
      disk = undefined;
    }
    if (disk && Date.now() - disk.at < FRESH_MS) {
      memory.set(key, disk);
      return disk.page;
    }
  }
  try {
    const page = await load();
    const entry = { at: Date.now(), page };
    memory.set(key, entry);
    AsyncStorage.setItem(DISK_PREFIX + key, JSON.stringify(entry)).catch(() => {});
    return page;
  } catch (e) {
    const old = hit ?? disk;
    if (old && Date.now() - old.at < STALE_MS) return old.page;
    throw e;
  }
}

/** Local catalog (demo mode, or AniList unreachable with nothing cached). */
function localPage(f: BrowseFilters, page: number, upcomingOnly = false): BrowsePage {
  const list = filterLocal(
    allSeries().filter((s) => s.anime && (!upcomingOnly || s.status === 'upcoming')),
    f,
  );
  const items = list.slice((page - 1) * PER_PAGE, page * PER_PAGE).map((s) => ({
    key: s.id,
    title: s.title,
    image: s.image,
    palette: s.palette,
    score: s.rating > 0 ? s.rating : null,
    year: s.year,
    badge: s.status === 'upcoming' ? 'À venir' : undefined,
    seriesId: s.id,
  }));
  return { items, hasNext: list.length > page * PER_PAGE };
}

export async function fetchBrowse(f: BrowseFilters, page = 1): Promise<BrowsePage> {
  if (isDemo) return localPage(f, page);
  const { query, variables } = buildBrowseQuery(f, page, PER_PAGE);
  return cached(`q:${filtersKey(f)}:${page}`, async () => {
    const data = await gql<{ Page: { pageInfo: { hasNextPage: boolean }; media: Light[] } }>(query, variables);
    return { items: data.Page.media.map((m) => toItem(m)), hasNext: data.Page.pageInfo.hasNextPage };
  });
}

/** Latest aired episodes, one card per series ("Récemment sortis"). */
export async function fetchRecentlyAired(page = 1): Promise<BrowsePage> {
  if (isDemo) {
    const local = allSeries().filter((s) => s.anime && s.status === 'ongoing');
    return {
      items: local.slice((page - 1) * PER_PAGE, page * PER_PAGE).map((s) => ({
        key: s.id, title: s.title, image: s.image, palette: s.palette, score: s.rating || null, year: s.year,
        badge: `Ép. ${s.anime!.episodes.length}`, seriesId: s.id,
      })),
      hasNext: local.length > page * PER_PAGE,
    };
  }
  // Rounded to 10 minutes so the cache key is stable.
  const now = Math.floor(Date.now() / 600e3) * 600;
  const { query, variables } = buildAiredQuery(page, now);
  return cached(`aired:${now}:${page}`, async () => {
    const data = await gql<{ Page: { pageInfo: { hasNextPage: boolean }; airingSchedules: { episode: number; media: (Light & { isAdult: boolean }) | null }[] } }>(query, variables);
    const seen = new Set<number>();
    const items: BrowseItem[] = [];
    for (const a of data.Page.airingSchedules) {
      if (!a.media || a.media.isAdult || seen.has(a.media.id)) continue;
      seen.add(a.media.id);
      items.push(toItem(a.media, `Ép. ${a.episode}`));
    }
    return { items, hasNext: data.Page.pageInfo.hasNextPage };
  });
}

/** Opens a card: catalog series directly, AniList entries fetched and registered first. */
export async function browseHref(item: BrowseItem): Promise<string> {
  if (item.seriesId) return `/anime/${item.seriesId}`;
  return openMedia(item.anilistId!, 'ANIME');
}

export type BrowseState = { items: BrowseItem[]; loading: boolean; error: string | null; hasNext: boolean; loadMore: () => void; reload: () => void };

/**
 * Paged results for a filter set (or the aired feed). `key` changes → starts over. Pages are
 * appended on `loadMore` (infinite scroll), duplicates dropped.
 */
export function useBrowse(f: BrowseFilters | null, aired = false, enabled = true): BrowseState {
  const key = f ? `${aired ? 'aired' : 'q'}:${filtersKey(f)}` : '';
  const [state, setState] = useState<{ key: string; items: BrowseItem[]; page: number; hasNext: boolean; loading: boolean; error: string | null }>({
    key: '', items: [], page: 0, hasNext: true, loading: false, error: null,
  });
  const [nonce, setNonce] = useState(0);
  const inflight = useRef<string | null>(null);

  const load = (page: number, reset: boolean) => {
    if (!f || !enabled) return;
    const tag = `${key}#${page}#${nonce}`;
    if (inflight.current === tag) return;
    inflight.current = tag;
    setState((s) => ({ ...(reset ? { key, items: [], page: 0, hasNext: true } : s), key, loading: true, error: null }) as typeof s);
    (aired ? fetchRecentlyAired(page) : fetchBrowse(f, page))
      .then((p) =>
        setState((s) => {
          if (s.key !== key) return s;
          const have = new Set(s.items.map((i) => i.key));
          return { key, items: [...s.items, ...p.items.filter((i) => !have.has(i.key))], page, hasNext: p.hasNext, loading: false, error: null };
        }),
      )
      .catch((e) => setState((s) => (s.key === key ? { ...s, loading: false, error: e instanceof Error ? e.message : String(e) } : s)))
      .finally(() => {
        if (inflight.current === tag) inflight.current = null;
      });
  };

  useEffect(() => {
    load(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, nonce]);

  const current = state.key === key;
  return {
    items: current ? state.items : [],
    loading: !current || state.loading,
    error: current ? state.error : null,
    hasNext: current && state.hasNext,
    loadMore: () => {
      if (current && !state.loading && state.hasNext && !state.error) load(state.page + 1, false);
    },
    reload: () => setNonce((n) => n + 1),
  };
}
