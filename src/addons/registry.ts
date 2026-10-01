// Installed addons (persisted, in priority order) + aggregation of stream / subtitles / catalog
// resources across all of them, with AniList ids translated to what each addon accepts.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { anilistNumber, useAnimeIds, type AnimeIds } from './ids';
import {
  type AddonStream,
  browsableCatalogs,
  catalogSupports,
  fetchCatalog,
  fetchManifest,
  fetchStreams,
  fetchSubtitles,
  isInfoStream,
  type Manifest,
  type ManifestCatalog,
  type MetaPreview,
  normalizeAddonUrl,
  prefixesFor,
  type Resource,
  searchableCatalogs,
  type StreamItem,
  supports,
} from './protocol';
import type { Quality } from './quality';

export type InstalledAddon = { baseUrl: string; manifest: Manifest; enabled: boolean };

const KEY = 'huwa/addons/v1';
const PREFS_KEY = 'huwa/addon-prefs/v1';
export const BUILTIN_ID = 'huwa.demo';

// Built-in demo source: open Blender / Apple test streams, so the player works with zero setup.
const DEMO_STREAMS = [
  { name: 'HLS 720p', title: 'Flux de test (Mux)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { name: 'MP4 480p', title: 'Sintel trailer (Blender, CC-BY)', url: 'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4' },
  { name: 'HLS adaptatif', title: 'Apple bipbop', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8' },
];

const builtin: InstalledAddon = {
  baseUrl: 'builtin:demo',
  enabled: true,
  manifest: {
    id: BUILTIN_ID,
    name: 'Démo Huwa',
    description: 'Flux de démonstration libres de droits. Installe un addon pour de vrais contenus.',
    resources: ['stream'],
    types: ['series', 'movie', 'anime'],
  },
};

export type AddonPrefs = { preferredQuality: Quality | 'auto'; legalAccepted: boolean };

type State = { addons: InstalledAddon[]; prefs: AddonPrefs };
let state: State = { addons: [builtin], prefs: { preferredQuality: 1080, legalAccepted: false } };
let hydrated = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function commit(next: InstalledAddon[]) {
  state = { ...state, addons: next };
  emit();
  // The demo entry is stored only as a placeholder (position + enabled); its manifest is rebuilt at load.
  AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
}

export function setPrefs(p: Partial<AddonPrefs>) {
  state = { ...state, prefs: { ...state.prefs, ...p } };
  emit();
  AsyncStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)).catch(() => {});
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useAddons() {
  return useSyncExternalStore(subscribe, () => state.addons, () => state.addons);
}
export function useAddonPrefs() {
  return useSyncExternalStore(subscribe, () => state.prefs, () => state.prefs);
}

export async function hydrateAddons() {
  if (hydrated) return;
  hydrated = true;
  try {
    const [raw, rawPrefs] = await Promise.all([AsyncStorage.getItem(KEY), AsyncStorage.getItem(PREFS_KEY)]);
    let addons = state.addons;
    if (raw) {
      const saved = JSON.parse(raw) as InstalledAddon[];
      addons = saved.map((a) => (a.baseUrl === builtin.baseUrl ? { ...builtin, enabled: a.enabled } : a));
      if (!addons.some((a) => a.baseUrl === builtin.baseUrl)) addons = [builtin, ...addons];
    }
    const prefs = rawPrefs ? { ...state.prefs, ...(JSON.parse(rawPrefs) as Partial<AddonPrefs>) } : state.prefs;
    state = { addons, prefs };
    emit();
  } catch {
    // keep defaults
  }
}

/** Fetches and validates an addon without installing it (for the confirmation sheet). */
export async function previewAddon(input: string) {
  const baseUrl = normalizeAddonUrl(input);
  const manifest = await fetchManifest(baseUrl);
  const existing = state.addons.find((a) => a.manifest.id === manifest.id);
  return { baseUrl, manifest, existing };
}

/**
 * Installs an addon. An addon with the same id is replaced in place (same priority): that is how
 * a reconfigured addon (new URL carrying its settings) updates, as in Stremio.
 */
export async function installAddon(input: string, preloaded?: Manifest) {
  const baseUrl = normalizeAddonUrl(input);
  const manifest = preloaded ?? (await fetchManifest(baseUrl));
  const i = state.addons.findIndex((a) => a.manifest.id === manifest.id);
  if (i >= 0) {
    const next = [...state.addons];
    next[i] = { ...next[i], baseUrl, manifest };
    commit(next);
  } else commit([...state.addons, { baseUrl, manifest, enabled: true }]);
  return manifest;
}

/** Re-reads the manifest of an installed addon (new catalogs, version…). */
export async function refreshAddon(baseUrl: string) {
  const manifest = await fetchManifest(baseUrl);
  commit(state.addons.map((a) => (a.baseUrl === baseUrl ? { ...a, manifest } : a)));
  return manifest;
}

export const removeAddon = (baseUrl: string) =>
  commit(state.addons.filter((a) => a.baseUrl !== baseUrl || a.baseUrl === builtin.baseUrl));
export const toggleAddon = (baseUrl: string) =>
  commit(state.addons.map((a) => (a.baseUrl === baseUrl ? { ...a, enabled: !a.enabled } : a)));

/** Moves an addon up (-1) or down (+1) in the priority list. */
export function moveAddon(baseUrl: string, dir: -1 | 1) {
  const list = [...state.addons];
  const i = list.findIndex((a) => a.baseUrl === baseUrl);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  commit(list);
}

// ---------- id translation ----------

/** Legacy helper: `anilist:<id>:<episode>`. */
export function videoId(seriesId: string, episode: number) {
  return `anilist:${seriesId.replace(/^al/, '')}:${episode}`;
}

export type AddonRequest = { type: string; id: string };

/**
 * Picks the id format and type an addon accepts for this episode, in this order:
 * anilist:, kitsu:, mal:, tt (IMDb `tt…:season:episode`). Addons without idPrefixes get IMDb
 * first (the Stremio default), then kitsu. Every accepted format, best first (`requestFor`: the
 * first one, or null). Aggregators like AIOStreams accept all of them but only find videos for
 * IMDb ids, hence the fallback in `useAggregate`.
 */
export function requestsFor(m: Manifest, resource: Resource, seriesId: string, episode: number, ids: AnimeIds | null): AddonRequest[] {
  const al = anilistNumber(seriesId);
  const movie = ids?.media === 'MOVIE';
  const ep = (base: string) => (movie ? base : `${base}:${episode}`);
  const cands: string[] = [];
  const anilistId = al != null ? ep(`anilist:${al}`) : null;
  const kitsu = ids?.kitsu ? ep(`kitsu:${ids.kitsu}`) : null;
  const mal = ids?.mal ? ep(`mal:${ids.mal}`) : null;
  // IMDb numbering is approximate for split-cour shows: TheTVDB season from ARM, episode as-is.
  const imdb = ids?.imdb ? (movie ? ids.imdb : `${ids.imdb}:${ids.season ?? 1}:${episode}`) : null;
  if (prefixesFor(m, resource).length) cands.push(...[anilistId, kitsu, mal, imdb].filter((x): x is string => !!x));
  else cands.push(...[imdb, kitsu, anilistId].filter((x): x is string => !!x));
  const types = movie ? ['movie', 'anime'] : ['series', 'anime'];
  const out: AddonRequest[] = [];
  for (const id of cands) {
    const type = types.find((t) => supports(m, resource, t, id));
    if (type) out.push({ type, id });
  }
  return out;
}

export function requestFor(m: Manifest, resource: Resource, seriesId: string, episode: number, ids: AnimeIds | null): AddonRequest | null {
  return requestsFor(m, resource, seriesId, episode, ids)[0] ?? null;
}

// ---------- aggregation hook ----------

type Agg<T> = { key: string; items: T[]; done: number; failed: string[] };

/**
 * Queries every enabled addon serving `resource` in parallel; results appear as each answers.
 * Waits for the id mapping first (AniList → Kitsu / MAL / IMDb).
 */
// Answers shared across screens: a prefetch of the next episode (see `useSource` with
// `enabled`) fills this cache, so opening that episode shows its sources immediately.
const aggCache = new Map<string, { agg: Agg<unknown>; at: number }>();
const AGG_TTL = 20 * 60e3;
const cachedAgg = <T,>(key: string) => {
  const hit = aggCache.get(key);
  return hit && Date.now() - hit.at < AGG_TTL ? (hit.agg as Agg<T>) : undefined;
};

function useAggregate<T>(
  resource: Resource,
  seriesId: string,
  episode: number,
  load: (a: InstalledAddon, req: AddonRequest) => Promise<T[]>,
  enabled = true,
  /** An answer with none of these tries the addon's next id format. */
  useful?: (item: T) => boolean,
) {
  const list = useAddons();
  const ids = useAnimeIds(seriesId);
  const idsReady = ids !== undefined;
  const jobs = idsReady && enabled
    ? list
        .filter((a) => a.enabled)
        .map((a) => {
          const reqs = a.baseUrl === builtin.baseUrl ? [{ type: 'series', id: videoId(seriesId, episode) }] : requestsFor(a.manifest, resource, seriesId, episode, ids ?? null);
          return { a, req: reqs[0], reqs };
        })
        .filter((j): j is { a: InstalledAddon; req: AddonRequest; reqs: AddonRequest[] } => !!j.req && (j.a.baseUrl !== builtin.baseUrl || resource === 'stream'))
    : [];
  const key = `${resource}|${seriesId}|${episode}|${idsReady}|${jobs.map((j) => `${j.a.baseUrl}>${j.req.type}/${j.req.id}`).join('|')}`;
  // Results are tagged with the request key, so stale answers are ignored without resetting state in an effect.
  const [res, setRes] = useState<Agg<T>>({ key: '', items: [], done: 0, failed: [] });

  useEffect(() => {
    let cancelled = false;
    // Complete fresh answer already fetched (e.g. prefetched while watching the previous episode).
    const hit = cachedAgg<T>(key);
    if (hit && hit.done >= jobs.length) return;
    const update = (fn: (base: Agg<T>) => Agg<T>) =>
      setRes((p) => {
        const base = p.key === key ? p : { key, items: [], done: 0, failed: [] };
        const next = fn(base);
        aggCache.set(key, { agg: next as Agg<unknown>, at: Date.now() });
        return next;
      });
    // Next id format when an addon has nothing usable for the first one (see `requestsFor`).
    const loadWithFallback = async (a: InstalledAddon, reqs: AddonRequest[]): Promise<T[]> => {
      let first: T[] | undefined;
      for (const req of reqs) {
        const items = await load(a, req).catch((e) => {
          if (first === undefined && req === reqs[reqs.length - 1]) throw e;
          return [] as T[];
        });
        first ??= items;
        if (!useful || items.some(useful)) return items;
      }
      return first ?? [];
    };
    for (const { a, reqs } of jobs) {
      loadWithFallback(a, reqs)
        .then((items) => {
          if (!cancelled) update((base) => ({ ...base, items: [...base.items, ...items], done: base.done + 1 }));
        })
        .catch(() => {
          if (!cancelled) update((base) => ({ ...base, done: base.done + 1, failed: [...base.failed, a.manifest.name] }));
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const cur = (res.key === key ? res : cachedAgg<T>(key)) ?? { items: [] as T[], done: 0, failed: [] as string[] };
  return { items: cur.items, pending: idsReady ? Math.max(0, jobs.length - cur.done) : enabled ? 1 : 0, failed: cur.failed };
}

/** Streams for an episode, unsorted (see `rankStreams`). */
export function useStreams(seriesId: string, episode: number, enabled = true) {
  const r = useAggregate<AddonStream>('stream', seriesId, episode, async (a, req) => {
    const items: StreamItem[] = a.baseUrl === builtin.baseUrl ? DEMO_STREAMS : await fetchStreams(a.baseUrl, req.type, req.id);
    return items.map((s) => ({ ...s, addonId: a.manifest.id, addonName: a.manifest.name }));
  }, enabled, (s) => !isInfoStream(s) && !!(s.url || s.infoHash || s.ytId));
  // Status rows (scrape summaries, errors, donation banners) are kept apart for the "Infos" section.
  const streams = r.items.filter((s) => !isInfoStream(s));
  const infos = r.items.filter(isInfoStream);
  return { streams, infos, pending: r.pending, failed: r.failed };
}

export type Subtitle = { url: string; lang: string; addonName: string; id?: string };

/** Subtitles from every installed addon with the `subtitles` resource (e.g. OpenSubtitles v3). */
export function useSubtitles(seriesId: string, episode: number, enabled = true): Subtitle[] {
  return useAggregate<Subtitle>('subtitles', seriesId, episode, async (a, req) =>
    (await fetchSubtitles(a.baseUrl, req.type, req.id)).map((s) => ({ url: s.url, lang: s.lang, id: s.id, addonName: a.manifest.name })),
  enabled).items;
}

// ---------- catalogs (Découvrir) ----------

export type CatalogDef = { addon: InstalledAddon; catalog: ManifestCatalog };
export const catalogKey = (d: CatalogDef) => `${d.addon.baseUrl}|${d.catalog.type}|${d.catalog.id}`;

/** Browsable catalogs of the enabled addons, in addon priority order. */
export function useCatalogDefs(): CatalogDef[] {
  const list = useAddons().filter((a) => a.enabled && a.baseUrl !== builtin.baseUrl);
  return list.flatMap((addon) => browsableCatalogs(addon.manifest).map((catalog) => ({ addon, catalog })));
}


/**
 * One catalog row with its `genre` filter and `skip` paging. `loadMore` fetches the next page
 * when the catalog declares `skip` and the last page was not empty.
 */
export function useCatalogRow(def: CatalogDef, genre?: string) {
  const key = `${catalogKey(def)}|${genre ?? ''}`;
  const [res, setRes] = useState<{ key: string; state: 'loading' | 'ok' | 'error'; metas: MetaPreview[]; more: boolean; busy: boolean }>({
    key: '', state: 'loading', metas: [], more: false, busy: false,
  });
  const canPage = catalogSupports(def.catalog, 'skip');

  const load = (skip: number) => {
    fetchCatalog(def.addon.baseUrl, def.catalog.type, def.catalog.id, { genre, skip: skip || undefined })
      .then((metas) =>
        setRes((p) => {
          const base = p.key === key ? p.metas : [];
          const seen = new Set(base.map((m) => m.id));
          const fresh = metas.filter((m) => !seen.has(m.id));
          return { key, state: 'ok', metas: [...base, ...fresh], more: canPage && fresh.length > 0, busy: false };
        }),
      )
      .catch(() => setRes((p) => (p.key === key && p.metas.length ? { ...p, more: false, busy: false } : { key, state: 'error', metas: [], more: false, busy: false })));
  };

  useEffect(() => {
    load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const cur = res.key === key ? res : { state: 'loading' as const, metas: [] as MetaPreview[], more: false, busy: false };
  return {
    ...cur,
    loadMore: () => {
      if (!cur.more || cur.busy || res.key !== key) return;
      setRes((p) => ({ ...p, busy: true }));
      load(cur.metas.length);
    },
  };
}

export type SearchHit = { addon: InstalledAddon; catalog: ManifestCatalog; metas: MetaPreview[] };

/** Text search across every catalog that accepts the `search` extra. */
export function useCatalogSearch(query: string) {
  const list = useAddons().filter((a) => a.enabled && a.baseUrl !== builtin.baseUrl);
  const defs = list.flatMap((addon) => searchableCatalogs(addon.manifest).map((catalog) => ({ addon, catalog })));
  const q = query.trim();
  const key = `${q}\n${defs.map(catalogKey).join('\n')}`;
  const [res, setRes] = useState<{ key: string; hits: SearchHit[]; done: number }>({ key: '', hits: [], done: 0 });

  useEffect(() => {
    if (q.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      for (const d of defs) {
        fetchCatalog(d.addon.baseUrl, d.catalog.type, d.catalog.id, { search: q })
          .catch(() => [] as MetaPreview[])
          .then((metas) => {
            if (cancelled) return;
            setRes((p) => {
              const base = p.key === key ? p : { key, hits: [], done: 0 };
              return { key, done: base.done + 1, hits: metas.length ? [...base.hits, { ...d, metas }] : base.hits };
            });
          });
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const cur = res.key === key ? res : { hits: [] as SearchHit[], done: 0 };
  return { searchable: defs.length, hits: cur.hits, pending: q.length < 2 ? 0 : Math.max(0, defs.length - cur.done) };
}

export const getAddonByBase = (baseUrl: string) => state.addons.find((a) => a.baseUrl === baseUrl);
