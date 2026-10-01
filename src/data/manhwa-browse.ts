// Data of the "Huwa" home of the Manhwa tab: AniList sections (one aliased request, cached
// stale-while-revalidate) and filtered browsing (paged, cached per filter set for the session).
// Demo mode never calls AniList: the same sections and filters run on the local catalog.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { isDemo } from '@/demo/flags';

import { build, NODE, type Media } from './anilist';
import { gql } from './anilist-api';
import { getSeries, manhwaSeries, registerSeries, type Series } from './catalog';
import { buildBrowseQuery, buildHomeQuery, filterLocal, filtersKey, HOME_SECTIONS, type HomeSectionId, type MangaFilters, type Origin } from './manhwa-filters';

type BrowseMedia = Media & { startDate?: { year: number | null } | null };
const FIELDS = `${NODE} startDate { year }`;
const HOME_KEY = 'huwa/manhwa/home/v1';
const HOME_TTL = 30 * 60e3;
const PER_PAGE = 30;

export type BrowseSeries = Series & { origin?: Origin };

function toSeries(m: BrowseMedia, rank: number): BrowseSeries | null {
  const s = build(null, m, rank);
  if (!s) return null;
  const origin = (m.countryOfOrigin ?? undefined) as Origin | undefined;
  return {
    ...s,
    year: m.startDate?.year ?? s.year,
    author: origin === 'CN' ? 'Manhua · Chine' : origin === 'JP' ? 'Manga · Japon' : s.author,
    origin,
  };
}

/** Series page of a browse result: registered on first open so its id resolves everywhere. */
export function openBrowseSeries(s: Series): string {
  if (!getSeries(s.id)) {
    const { origin: _o, ...rest } = s as BrowseSeries;
    registerSeries([rest]);
  }
  return `/manhwa/${s.id}`;
}

// ---------- home sections ----------

export type HomeData = Record<HomeSectionId, BrowseSeries[]>;
type HomeState = { state: 'loading' | 'ok' | 'error'; data?: HomeData; at: number; error?: string };

let home: HomeState = { state: 'loading', at: 0 };
const homeListeners = new Set<() => void>();
const setHome = (h: Partial<HomeState>) => {
  home = { ...home, ...h };
  homeListeners.forEach((l) => l());
};

function localHome(): HomeData {
  const all = manhwaSeries() as BrowseSeries[];
  const base: MangaFilters = { query: '', genres: [], status: null, origin: null, yearFrom: null, yearTo: null, minScore: null, sort: 'trending' };
  return Object.fromEntries(HOME_SECTIONS.map((s) => [s.id, filterLocal(all, { ...base, sort: s.sort })])) as HomeData;
}

const toHome = (raw: Record<HomeSectionId, BrowseMedia[]>) =>
  Object.fromEntries(
    HOME_SECTIONS.map((s) => [s.id, (raw[s.id] ?? []).map((m, i) => toSeries(m, i + 1)).filter((x): x is BrowseSeries => !!x)]),
  ) as HomeData;

let homeLoad: Promise<void> | undefined;
export function loadManhwaHome(force = false) {
  if (isDemo) {
    setHome({ state: 'ok', data: localHome(), at: Date.now() });
    return Promise.resolve();
  }
  if (!force && homeLoad) return homeLoad;
  if (!force && home.state === 'ok' && Date.now() - home.at < HOME_TTL) return Promise.resolve();
  homeLoad = (async () => {
    if (!home.data) {
      try {
        const raw = await AsyncStorage.getItem(HOME_KEY);
        if (raw) {
          const cached = JSON.parse(raw) as { at: number; raw: Record<HomeSectionId, BrowseMedia[]> };
          setHome({ state: 'ok', data: toHome(cached.raw), at: cached.at });
          if (!force && Date.now() - cached.at < HOME_TTL) return;
        }
      } catch {
        // refetch below
      }
    }
    try {
      const { query, variables } = buildHomeQuery('KR', FIELDS, new Date());
      const res = await gql<Record<HomeSectionId, { media: BrowseMedia[] }>>(query, variables);
      // The raw media are cached (small), not the built series (placeholder chapter lists).
      const rawLists = Object.fromEntries(HOME_SECTIONS.map((s) => [s.id, res[s.id]?.media ?? []])) as Record<HomeSectionId, BrowseMedia[]>;
      const at = Date.now();
      setHome({ state: 'ok', data: toHome(rawLists), at, error: undefined });
      AsyncStorage.setItem(HOME_KEY, JSON.stringify({ at, raw: rawLists })).catch(() => {});
    } catch (e) {
      // Offline: keep the cached sections, else fall back to the catalog.
      if (home.data) setHome({ state: 'ok' });
      else setHome({ state: 'ok', data: localHome(), error: e instanceof Error ? e.message : 'AniList indisponible' });
    }
  })().finally(() => {
    homeLoad = undefined;
  });
  return homeLoad;
}

export function useManhwaHome(): HomeState {
  const h = useSyncExternalStore(
    (l) => {
      homeListeners.add(l);
      return () => homeListeners.delete(l);
    },
    () => home,
    () => home,
  );
  useEffect(() => {
    loadManhwaHome().catch(() => {});
  }, []);
  return h;
}

// ---------- filtered browsing ----------

type Pages = { items: BrowseSeries[]; page: number; hasNext: boolean };
const browseCache = new Map<string, Pages>();

async function fetchPage(f: MangaFilters, page: number): Promise<{ items: BrowseSeries[]; hasNext: boolean }> {
  if (isDemo) {
    const all = filterLocal(manhwaSeries() as BrowseSeries[], f);
    return { items: all.slice((page - 1) * PER_PAGE, page * PER_PAGE), hasNext: all.length > page * PER_PAGE };
  }
  const { query, variables } = buildBrowseQuery(f, page, FIELDS, PER_PAGE);
  const res = await gql<{ Page: { pageInfo: { hasNextPage: boolean }; media: BrowseMedia[] } }>(query, variables);
  return {
    items: res.Page.media.map((m, i) => toSeries(m, (page - 1) * PER_PAGE + i + 1)).filter((x): x is BrowseSeries => !!x),
    hasNext: res.Page.pageInfo.hasNextPage,
  };
}

export type BrowseState = { items: BrowseSeries[]; loading: boolean; error?: string; hasNext: boolean; loadMore: () => void; retry: () => void };

/** Results of a filter set, page by page (infinite scroll). */
export function useBrowse(f: MangaFilters, enabled: boolean): BrowseState {
  const key = filtersKey(f);
  const [state, setState] = useState<{ key: string; pages?: Pages; loading: boolean; error?: string }>({ key: '', loading: false });
  const [gen, setGen] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const cached = browseCache.get(key);
    let alive = true;
    if (cached) {
      Promise.resolve().then(() => alive && setState({ key, pages: cached, loading: false }));
      return () => {
        alive = false;
      };
    }
    Promise.resolve().then(() => alive && setState({ key, loading: true }));
    fetchPage(f, 1)
      .then((r) => {
        const pages = { items: r.items, page: 1, hasNext: r.hasNext };
        browseCache.set(key, pages);
        if (alive) setState({ key, pages, loading: false });
      })
      .catch((e: unknown) => alive && setState({ key, loading: false, error: e instanceof Error ? e.message : 'Erreur' }));
    return () => {
      alive = false;
    };
    // `f` is described by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, gen]);

  const current = state.key === key ? state : { key, loading: enabled, pages: undefined, error: undefined };
  const pages = current.pages;

  const loadMore = useCallback(() => {
    if (!pages?.hasNext || current.loading) return;
    setState((s) => ({ ...s, loading: true }));
    fetchPage(f, pages.page + 1)
      .then((r) => {
        const seen = new Set(pages.items.map((s) => s.id));
        const next = { items: [...pages.items, ...r.items.filter((s) => !seen.has(s.id))], page: pages.page + 1, hasNext: r.hasNext };
        browseCache.set(key, next);
        setState({ key, pages: next, loading: false });
      })
      .catch((e: unknown) => setState({ key, pages, loading: false, error: e instanceof Error ? e.message : 'Erreur' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pages, current.loading]);

  const retry = useCallback(() => {
    browseCache.delete(key);
    setGen((g) => g + 1);
  }, [key]);

  return { items: pages?.items ?? [], loading: current.loading, error: current.error, hasNext: !!pages?.hasNext, loadMore, retry };
}
