// Installed addons (persisted, in priority order) + aggregation of stream / subtitles / catalog
// resources across all of them, with AniList ids translated to what each addon accepts.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { anilistNumber, useAnimeIds, type AnimeIds } from './ids';
import {
  type AddonStream,
  browsableCatalogs,
  fetchCatalog,
  fetchManifest,
  fetchStreams,
  fetchSubtitles,
  type Manifest,
  type ManifestCatalog,
  type MetaPreview,
  normalizeAddonUrl,
  prefixesFor,
  type Resource,
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

export async function installAddon(input: string) {
  const baseUrl = normalizeAddonUrl(input);
  const manifest = await fetchManifest(baseUrl);
  if (state.addons.some((a) => a.manifest.id === manifest.id)) throw new Error('Addon déjà installé');
  commit([...state.addons, { baseUrl, manifest, enabled: true }]);
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
 * first (the Stremio default), then kitsu. Returns null when nothing matches.
 */
export function requestFor(m: Manifest, resource: Resource, seriesId: string, episode: number, ids: AnimeIds | null): AddonRequest | null {
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
  for (const id of cands) for (const type of types) if (supports(m, resource, type, id)) return { type, id };
  return null;
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
) {
  const list = useAddons();
  const ids = useAnimeIds(seriesId);
  const idsReady = ids !== undefined;
  const jobs = idsReady && enabled
    ? list
        .filter((a) => a.enabled)
        .map((a) => ({ a, req: a.baseUrl === builtin.baseUrl ? { type: 'series', id: videoId(seriesId, episode) } : requestFor(a.manifest, resource, seriesId, episode, ids ?? null) }))
        .filter((j): j is { a: InstalledAddon; req: AddonRequest } => !!j.req && (j.a.baseUrl !== builtin.baseUrl || resource === 'stream'))
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
    for (const { a, req } of jobs) {
      load(a, req)
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
    const items = a.baseUrl === builtin.baseUrl ? DEMO_STREAMS : await fetchStreams(a.baseUrl, req.type, req.id);
    return items.map((s) => ({ ...s, addonId: a.manifest.id, addonName: a.manifest.name }));
  }, enabled);
  return { streams: r.items, pending: r.pending, failed: r.failed };
}

export type Subtitle = { url: string; lang: string; addonName: string; id?: string };

/** Subtitles from every installed addon with the `subtitles` resource (e.g. OpenSubtitles v3). */
export function useSubtitles(seriesId: string, episode: number, enabled = true): Subtitle[] {
  return useAggregate<Subtitle>('subtitles', seriesId, episode, async (a, req) =>
    (await fetchSubtitles(a.baseUrl, req.type, req.id)).map((s) => ({ url: s.url, lang: s.lang, id: s.id, addonName: a.manifest.name })),
  enabled).items;
}

// ---------- catalogs (Découvrir) ----------

export type CatalogRow = { addon: InstalledAddon; catalog: ManifestCatalog; state: 'loading' | 'ok' | 'error'; metas: MetaPreview[] };

export function useAddonCatalogs(): CatalogRow[] {
  const list = useAddons().filter((a) => a.enabled && a.baseUrl !== builtin.baseUrl);
  const defs = list.flatMap((addon) => browsableCatalogs(addon.manifest).map((catalog) => ({ addon, catalog })));
  const rowKey = (d: { addon: InstalledAddon; catalog: ManifestCatalog }) => `${d.addon.baseUrl}|${d.catalog.type}|${d.catalog.id}`;
  const key = defs.map(rowKey).join('\n');
  const [res, setRes] = useState<{ key: string; rows: Record<string, { state: 'ok' | 'error'; metas: MetaPreview[] }> }>({ key: '', rows: {} });

  useEffect(() => {
    let cancelled = false;
    for (const d of defs) {
      fetchCatalog(d.addon.baseUrl, d.catalog.type, d.catalog.id)
        .then((metas) => ({ state: 'ok' as const, metas }))
        .catch(() => ({ state: 'error' as const, metas: [] }))
        .then((row) => {
          if (cancelled) return;
          setRes((p) => ({ key, rows: { ...(p.key === key ? p.rows : {}), [rowKey(d)]: row } }));
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return defs.map((d) => {
    const r = res.key === key ? res.rows[rowKey(d)] : undefined;
    return { ...d, state: r?.state ?? 'loading', metas: r?.metas ?? [] };
  });
}

export const getAddonByBase = (baseUrl: string) => state.addons.find((a) => a.baseUrl === baseUrl);
