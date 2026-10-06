// Installed addons (store: ./addon-store.ts) + aggregation of stream / subtitles / catalog
// resources across all of them (engine: ./agg-jobs.ts), with AniList ids translated to what each
// addon accepts.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { extraKey, rankSubtitles, type SubMatch } from '@/subtitles/request';

import { aggregateBase, aggregateKey, type Agg, type JobOptions, type JobSpec, type Loader, obtainAggregate } from './agg-jobs';
import { absoluteNumbering, requestsFor, type AddonRequest } from './id-candidates';
import { useAnimeIds, type AnimeIds } from './ids';
import {
  type AddonStream,
  browsableCatalogs,
  catalogSupports,
  fetchCatalog,
  fetchStreams,
  fetchSubtitles,
  isInfoStream,
  type Manifest,
  type ManifestCatalog,
  type MetaPreview,
  type Resource,
  searchableCatalogs,
  type StreamItem,
  type SubtitleExtra,
  type SubtitleItem,
} from './protocol';
import { dropDemoWhenReal } from './builtin-demo';
import { timedAddon } from '@/stats/addon-timing';
import { lazyImdbId } from '@/data/imdb-episode';

import {
  type AddonPrefs,
  builtin,
  getAddonsState,
  isAddonsHydrated,
  subscribeAddons,
  type InstalledAddon,
} from './addon-store';

export {
  type AddonPrefs,
  addonSetHash,
  BUILTIN_ID,
  getAddonByBase,
  hydrateAddons,
  installAddon,
  type InstalledAddon,
  moveAddon,
  onAddonsAdded,
  previewAddon,
  refreshAddon,
  removeAddon,
  setPrefs,
  toggleAddon,
} from './addon-store';

// Built-in demo source: open Blender / Apple test streams, so the player works with zero setup.
const DEMO_STREAMS = [
  { name: 'HLS 720p', title: 'Flux de test (Mux)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { name: 'MP4 480p', title: 'Sintel trailer (Blender, CC-BY)', url: 'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4' },
  { name: 'HLS adaptatif', title: 'Apple bipbop', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8' },
];

const getAddons = () => getAddonsState().addons;
const getPrefs = () => getAddonsState().prefs;
const getSetHash = () => getAddonsState().setHash;

export function useAddons(): InstalledAddon[] {
  return useSyncExternalStore(subscribeAddons, getAddons, getAddons);
}
export function useAddonPrefs(): AddonPrefs {
  return useSyncExternalStore(subscribeAddons, getPrefs, getPrefs);
}
/** Hash of the installed set (order, enabled, manifests): changes with any add / remove / toggle / move. */
export function useAddonSetHash(): string {
  return useSyncExternalStore(subscribeAddons, getSetHash, getSetHash);
}
/** The saved addon list is loaded (before that, only the demo is known). */
export function useAddonsHydrated(): boolean {
  return useSyncExternalStore(subscribeAddons, isAddonsHydrated, isAddonsHydrated);
}

// ---------- id translation ----------

/** Legacy helper: `anilist:<id>:<episode>`. */
export function videoId(seriesId: string, episode: number) {
  return `anilist:${seriesId.replace(/^al/, '')}:${episode}`;
}

export { requestsFor, type AddonRequest } from './id-candidates';

export function requestFor(m: Manifest, resource: Resource, seriesId: string, episode: number, ids: AnimeIds | null): AddonRequest | null {
  return requestsFor(m, resource, seriesId, episode, ids)[0] ?? null;
}

const EMPTY_AGG: Agg<never> = { key: '', items: [], done: 0, failed: [], fromCache: 0, refreshed: 0 };
const noSub = () => () => {};
const emptySnap = () => EMPTY_AGG;

/**
 * Queries every enabled addon serving `resource` (see ./agg-jobs.ts); results appear as each
 * answers. Waits for the saved addon list. Waits for the id mapping first (AniList → Kitsu / MAL / IMDb + episode offsets).
 */
function useAggregate<T>(
  resource: Resource,
  seriesId: string,
  episode: number,
  load: Loader<T>,
  enabled = true,
  opts: JobOptions<T> = {},
  /** Distinguishes requests of one resource that differ by their extras (exact-file subtitles). */
  variant = '',
) {
  const list = useAddons();
  const setHash = useAddonSetHash();
  // Before the saved list is loaded only the demo is known: asking it would pick a test stream.
  const hydrated = useAddonsHydrated();
  const ids = useAnimeIds(seriesId);
  const ready = ids !== undefined && hydrated;
  // Absolute entries (One Piece): IMDb numbering from the season model, resolved when asked.
  const lazy = ids && absoluteNumbering(ids) ? lazyImdbId(seriesId, episode, ids) : undefined;
  const asked: JobSpec[] = ready && enabled
    ? list
        .filter((a) => a.enabled && (a.baseUrl !== builtin.baseUrl || resource === 'stream'))
        .map((a) => ({
          a,
          reqs: a.baseUrl === builtin.baseUrl ? [{ type: 'series', id: videoId(seriesId, episode) }] : requestsFor(a.manifest, resource, seriesId, episode, ids ?? null, lazy),
        }))
        .filter((j) => j.reqs.length > 0)
    : [];
  const specs = dropDemoWhenReal(asked, builtin.baseUrl, resource);
  const base = aggregateBase(resource, variant, seriesId, episode);
  // Keyed by the installed set: any add / remove / toggle / move gets a new aggregate at once
  // (never the old set's "nothing found"), made of the answers already known plus the new ones.
  const key = ready && enabled ? aggregateKey(base, setHash, specs) : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const job = useMemo(() => (key ? obtainAggregate<T>(base, setHash, resource, specs, opts) : null), [key]);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    if (!job) return;
    return job.retain((a, req) => loadRef.current(a, req));
  }, [job]);
  const snap = useSyncExternalStore(job?.subscribe ?? noSub, job?.getSnapshot ?? emptySnap, job?.getSnapshot ?? emptySnap) as Agg<T>;
  return {
    items: snap.items,
    pending: ready ? Math.max(0, specs.length - snap.done) : enabled ? 1 : 0,
    failed: snap.failed,
    /** Addons asked for this episode. */
    asked: specs.length,
    fromCache: snap.fromCache,
    refreshed: snap.refreshed,
    refresh: (all?: boolean) => job?.refresh(all),
  };
}

const sameStream = (a: AddonStream, b: AddonStream) =>
  (!!a.url && a.url === b.url) || (!!a.infoHash && a.infoHash === b.infoHash && a.fileIdx === b.fileIdx && !a.url && !b.url);

const streamOpts: JobOptions<AddonStream> = {
  useful: (s) => !isInfoStream(s) && !!(s.url || s.infoHash || s.ytId),
  persist: true,
  tag: (s, at) => ({ ...s, cachedAt: at }),
  same: sameStream,
};

/** Streams for an episode, unsorted (see `rankStreams`). */
export function useStreams(seriesId: string, episode: number, enabled = true) {
  const r = useAggregate<AddonStream>('stream', seriesId, episode, async (a, req) => {
    const items: StreamItem[] = a.baseUrl === builtin.baseUrl ? DEMO_STREAMS : await timedAddon(a.manifest, () => fetchStreams(a.baseUrl, req.type, req.id));
    return items.map((s) => ({ ...s, addonId: a.manifest.id, addonName: a.manifest.name }));
  }, enabled, streamOpts);
  // Status rows (scrape summaries, errors, donation banners) are kept apart for the "Infos" section.
  const streams = useMemo(() => r.items.filter((s) => !isInfoStream(s)), [r.items]);
  const infos = useMemo(() => r.items.filter(isInfoStream), [r.items]);
  return { streams, infos, pending: r.pending, failed: r.failed, asked: r.asked, fromCache: r.fromCache, refreshed: r.refreshed, refresh: r.refresh };
}

export type Subtitle = {
  url: string;
  lang: string;
  addonName: string;
  id?: string;
  /** Matches the playing file (see `rankSubtitles`). */
  match?: SubMatch;
};

type RawSubtitle = Subtitle & Pick<SubtitleItem, 'm' | 'hashMatch' | 'release' | 'filename'>;

const subtitleOpts: JobOptions<RawSubtitle> = { same: (a, b) => a.url === b.url };

/**
 * Subtitles from every installed addon with the `subtitles` resource (e.g. OpenSubtitles v3).
 * `video` (the playing stream's `videoHash` / `videoSize` / `filename`) adds a second, exact-file
 * request, asked again whenever the file changes; the plain answer stays meanwhile. Ranked: files
 * matching the video first, then the user's languages.
 */
export function useSubtitles(seriesId: string, episode: number, enabled = true, video?: SubtitleExtra | null, subLangs: string[] = []): Subtitle[] {
  const toSub = (a: InstalledAddon, list: SubtitleItem[]): RawSubtitle[] =>
    list.map((s) => ({ url: s.url, lang: s.lang, id: s.id, addonName: a.manifest.name, m: s.m, hashMatch: s.hashMatch, release: s.release, filename: s.filename }));
  const plain = useAggregate<RawSubtitle>('subtitles', seriesId, episode, async (a, req) =>
    toSub(a, await fetchSubtitles(a.baseUrl, req.type, req.id)),
  enabled, subtitleOpts).items;
  const vKey = extraKey(video);
  const exact = useAggregate<RawSubtitle>('subtitles', seriesId, episode, async (a, req) =>
    toSub(a, await fetchSubtitles(a.baseUrl, req.type, req.id, video ?? undefined)),
  enabled && !!vKey, subtitleOpts, vKey).items;
  const langsKey = subLangs.join(',');
  return useMemo(() => {
    const seen = new Set<string>();
    const all = [...exact, ...plain].filter((s) => !seen.has(s.url) && !!seen.add(s.url));
    return rankSubtitles(all, subLangs, video).map(({ url, lang, id, addonName, match }) => ({ url, lang, id, addonName, match }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exact, plain, langsKey, vKey]);
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
