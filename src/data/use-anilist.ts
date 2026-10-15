// React side of the AniList queries, through the SWR cache (./swr.ts): search results, the
// airing calendar and series pages opened outside the trending catalog all show cached data on
// the first frame and refresh in the background.
import { useEffect, useState } from 'react';

import { build } from './anilist';
import {
  anilistRef,
  fetchAiring,
  fetchMediaFull,
  mediaKey,
  searchMedia,
  seriesFromMedia,
  type AiringItem,
  type MediaSummary,
  type SearchParams,
} from './anilist-api';
import { getExtra, getSeries, inTrending, registerSeries, useCatalogLoading, type Series } from './catalog';
import { cache, TTL, useSwr } from './swr';

// ---------- search ----------

export const searchKey = (p: SearchParams) =>
  `search:${JSON.stringify([p.query.trim().toLowerCase(), p.type, p.genre, p.year, p.status, p.sort])}`;

/**
 * Results for `params`, debounced while typing (AniList rate-limits). A query already in the cache
 * shows at once; while a new one loads, the previous results stay on screen.
 */
export function useSearchResults(params: SearchParams, delays = { typing: 450, filters: 150 }) {
  const key = searchKey(params);
  const [active, setActive] = useState({ key, params, prev: null as string | null });
  useEffect(() => {
    if (key === active.key) return;
    const hit = cache.peek(key);
    const timer = setTimeout(
      () => setActive((a) => ({ key, params, prev: a.key })),
      hit ? 0 : params.query.trim() ? delays.typing : delays.filters,
    );
    return () => clearTimeout(timer);
    // `params` is described by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active.key]);
  const res = useSwr<MediaSummary[]>(active.key, () => searchMedia(active.params), TTL.search);
  const shown = res.data ?? (active.prev ? cache.peek<MediaSummary[]>(active.prev)?.value : undefined);
  return {
    results: shown ?? null,
    /** A request runs (debounce included): spinner next to the field. */
    busy: key !== active.key || res.loading || res.refreshing,
    /** Nothing at all to show yet: skeleton grid. */
    loading: !shown && (key !== active.key || res.loading),
    failed: !!res.error && !res.data && !res.loading,
    retry: res.reload,
  };
}

// ---------- airing calendar ----------

const DAY_MS = 86_400_000;

/** Every episode airing in the 7 days from local midnight `today` (ms), cached per start day. */
export function useAiringWeek(today: number) {
  const res = useSwr<AiringItem[]>(
    `airing:${today}`,
    () => fetchAiring(Math.floor(today / 1000), Math.floor((today + 7 * DAY_MS) / 1000)),
    TTL.calendar,
  );
  return { items: res.data ?? null, failed: !!res.error && !res.data && !res.loading, retry: res.reload };
}

// ---------- series pages ----------

export type EnsuredSeries = { series: Series | undefined; state: 'ready' | 'loading' | 'missing' };

/** The series an AniList entry gives for page `id` (a manhwa page keeps its manga id). */
function seriesFor(id: string, media: Parameters<typeof seriesFromMedia>[0]): Series | null {
  const s = seriesFromMedia(media);
  if (s?.id === id) return s;
  return id.startsWith('alm') ? build(null, media, 999) : media.type === 'ANIME' ? build(media, null, 999) : null;
}

/**
 * Series of a detail page. Opened from a link (nothing cached yet): fetched from AniList while the
 * page shows its skeleton. Outside the trending catalog: refreshed in the background when its data
 * is older than 12 h (scores, episode counts), the page re-renders only if something changed.
 */
export function useEnsureSeries(id: string): EnsuredSeries {
  const catalogLoading = useCatalogLoading();
  const series = getSeries(id);
  const ref = anilistRef(id);
  // Trending series are refreshed with the catalog; while it loads, wait for it first.
  const own = !!ref && !(series && inTrending(id)) && !(catalogLoading && !series);
  const res = useSwr(own && ref ? mediaKey(ref.id) : null, () => fetchMediaFull(ref!.id), TTL.series);
  const fresh = res.data ? seriesFor(id, res.data) : null;
  useEffect(() => {
    if (!fresh || inTrending(id)) return;
    const stored = getExtra(id);
    if (!stored || JSON.stringify(stored) !== JSON.stringify(fresh)) registerSeries([fresh]);
  }, [fresh, id]);
  if (series) return { series, state: 'ready' };
  // `fresh` without `series`: registered by the effect above, on the next render.
  if (catalogLoading || res.loading || fresh) return { series, state: 'loading' };
  return { series, state: 'missing' };
}
