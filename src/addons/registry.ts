// Installed addons (persisted, in priority order) + aggregation of stream / subtitles / catalog
// resources across all of them, with AniList ids translated to what each addon accepts.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { extraKey, rankSubtitles, type SubMatch } from '@/subtitles/request';

import { firstUseful, withRetry } from './fetch-policy';
import { requestsFor, type AddonRequest } from './id-candidates';
import { useAnimeIds, type AnimeIds } from './ids';
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
  type Resource,
  searchableCatalogs,
  type StreamItem,
  type SubtitleExtra,
  type SubtitleItem,
} from './protocol';
import type { Quality } from './quality';
import { dropAnswer, freshness, readAnswer, writeAnswer } from './stream-cache';
import { timedAddon } from '@/stats/addon-timing';
import { registerRehydrate } from '@/settings/rehydrate';

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

registerRehydrate(() => {
  if (!hydrated) return;
  hydrated = false;
  state = { addons: [builtin], prefs: { preferredQuality: 1080, legalAccepted: false } };
  return hydrateAddons();
});

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

export { requestsFor, type AddonRequest } from './id-candidates';

export function requestFor(m: Manifest, resource: Resource, seriesId: string, episode: number, ids: AnimeIds | null): AddonRequest | null {
  return requestsFor(m, resource, seriesId, episode, ids)[0] ?? null;
}

// ---------- aggregation ----------
// One shared job per (resource, episode, addons, ids): the pre-search of a detail page, the next
// episode prefetch and the watch screen all read the same job, so opening an episode whose
// sources are already being searched never starts over. Per addon:
// 1. an answer stored on disk (./stream-cache.ts) is shown at once; refreshed in the background
//    when older than a few minutes;
// 2. otherwise its id formats are asked two at a time (./fetch-policy.ts `firstUseful`), each
//    request retried once on a transient failure; results appear as each addon answers.
// A job keeps running while a screen uses it, plus a short grace period (screen handover); then
// no new request starts (requests in flight still land in the caches).

type Agg<T> = {
  key: string;
  items: T[];
  done: number;
  failed: string[];
  /** Addons whose answer currently comes from the disk cache. */
  fromCache: number;
  /** Forced refreshes completed (see `refresh`). */
  refreshed: number;
};

type Slot<T> = { items: T[]; done: boolean; failed: boolean; running: boolean; cachedAt?: number; reqKey?: string };
type JobSpec = { a: InstalledAddon; reqs: AddonRequest[] };
type Loader<T> = (a: InstalledAddon, req: AddonRequest) => Promise<T[]>;
type JobOptions<T> = {
  useful?: (item: T) => boolean;
  /** Keep answers on disk (streams). */
  persist?: boolean;
  /** Marks an item served from the disk cache. */
  tag?: (item: T, cachedAt: number) => T;
  /** Two items of one addon are the same (merging answers of several id formats). */
  same?: (a: T, b: T) => boolean;
};

const AGG_TTL = 20 * 60e3;
const RELEASE_GRACE_MS = 4000;
const PER_ADDON_CONCURRENCY = 2;
const reqKeyOf = (a: InstalledAddon, resource: Resource, req: AddonRequest) => `${resource}|${a.baseUrl}|${req.type}/${req.id}`;

class AggJob<T> {
  slots = new Map<string, Slot<T>>();
  snapshot: Agg<T>;
  at = Date.now();
  refs = 0;
  ctrl = new AbortController();
  load!: Loader<T>;
  private listeners = new Set<() => void>();
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshed = 0;

  constructor(
    readonly key: string,
    readonly resource: Resource,
    readonly specs: JobSpec[],
    readonly opts: JobOptions<T>,
  ) {
    for (const s of specs) this.slots.set(s.a.baseUrl, { items: [], done: false, failed: false, running: false });
    this.snapshot = { key, items: [], done: 0, failed: [], fromCache: 0, refreshed: 0 };
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getSnapshot = () => this.snapshot;

  get complete() {
    return [...this.slots.values()].every((s) => s.done);
  }

  private emit() {
    const slots = this.specs.map((s) => this.slots.get(s.a.baseUrl)!);
    this.snapshot = {
      key: this.key,
      items: slots.flatMap((s) => s.items),
      done: slots.filter((s) => s.done).length,
      failed: this.specs.filter((s) => this.slots.get(s.a.baseUrl)!.failed).map((s) => s.a.manifest.name),
      fromCache: slots.filter((s) => s.cachedAt != null).length,
      refreshed: this.refreshed,
    };
    this.at = Date.now();
    this.listeners.forEach((l) => l());
  }

  retain(load: Loader<T>) {
    this.load = load;
    this.refs++;
    clearTimeout(this.stopTimer);
    if (this.ctrl.signal.aborted) this.ctrl = new AbortController();
    for (const spec of this.specs) {
      const slot = this.slots.get(spec.a.baseUrl)!;
      if (!slot.done && !slot.running) void this.run(spec);
    }
    return () => {
      this.refs--;
      if (this.refs > 0) return;
      clearTimeout(this.stopTimer);
      this.stopTimer = setTimeout(() => {
        if (this.refs === 0) this.ctrl.abort();
      }, RELEASE_GRACE_MS);
    };
  }

  private async run(spec: JobSpec) {
    const slot = this.slots.get(spec.a.baseUrl)!;
    slot.running = true;
    try {
      if (this.opts.persist && !spec.a.baseUrl.startsWith('builtin:')) {
        for (const req of spec.reqs) {
          const key = reqKeyOf(spec.a, this.resource, req);
          const hit = await readAnswer<T>(key);
          if (!hit || (this.opts.useful && !hit.items.some(this.opts.useful))) continue;
          const tag = this.opts.tag;
          Object.assign(slot, { items: tag ? hit.items.map((x) => tag(x, hit.at)) : hit.items, done: true, cachedAt: hit.at, reqKey: key });
          this.emit();
          // Shown at once; refreshed when older than a few minutes (stale-while-revalidate).
          if (freshness(hit.at) === 'stale') await this.network(spec, slot);
          return;
        }
      }
      await this.network(spec, slot);
    } finally {
      slot.running = false;
    }
  }

  /** Asks the addon (all its id formats, two at a time), replacing what the slot shows. */
  private async network(spec: JobSpec, slot: Slot<T>) {
    const signal = this.ctrl.signal;
    if (signal.aborted) return;
    const { useful, same } = this.opts;
    const merge = (items: T[]) => {
      const fresh = same ? items.filter((x) => !slot.items.some((y) => same(x, y))) : items;
      if (!fresh.length) return;
      slot.items = [...slot.items, ...fresh];
      this.emit();
    };
    try {
      const { items, index } = await firstUseful(
        spec.reqs,
        (req) => withRetry(() => this.load(spec.a, req), { signal }),
        useful,
        { concurrency: PER_ADDON_CONCURRENCY, signal, onExtra: merge },
      );
      const isUseful = !useful || items.some(useful);
      // Background refresh that found nothing better: keep the cached answer.
      if (slot.cachedAt != null && !isUseful) return;
      // Stopped before every id format was tried: not an answer yet (runs again when retained).
      if (!isUseful && signal.aborted) return;
      Object.assign(slot, { items, done: true, failed: false, cachedAt: undefined });
      if (isUseful && this.opts.persist && index >= 0 && !spec.a.baseUrl.startsWith('builtin:')) {
        slot.reqKey = reqKeyOf(spec.a, this.resource, spec.reqs[index]);
        void writeAnswer(slot.reqKey, items);
      }
      this.emit();
    } catch {
      if (slot.cachedAt != null) return;
      // Cancelled before any request could start: not a failure, it may run again.
      if (signal.aborted && !slot.items.length) return;
      Object.assign(slot, { done: true, failed: true });
      this.emit();
    }
  }

  /**
   * Fetches again every addon answer that came from the disk cache (a cached link failed:
   * debrid / proxy URLs expire), or every addon with `all` ("Réessayer"). `refreshed`
   * increments when done.
   */
  async refresh(all = false) {
    if (this.ctrl.signal.aborted) this.ctrl = new AbortController();
    const todo = this.specs.filter((s) => {
      const slot = this.slots.get(s.a.baseUrl)!;
      return !slot.running && (all || slot.cachedAt != null);
    });
    await Promise.all(
      todo.map(async (spec) => {
        const slot = this.slots.get(spec.a.baseUrl)!;
        if (slot.reqKey) void dropAnswer(slot.reqKey);
        // Shown again as "searching" only when it had nothing to show.
        if (all && !slot.items.length) {
          Object.assign(slot, { done: false, failed: false });
          this.emit();
        }
        slot.running = true;
        try {
          await this.network(spec, slot);
        } finally {
          slot.running = false;
        }
      }),
    );
    this.refreshed++;
    this.emit();
  }
}

const jobs = new Map<string, AggJob<unknown>>();

function obtainJob<T>(key: string, resource: Resource, specs: JobSpec[], opts: JobOptions<T>): AggJob<T> {
  const now = Date.now();
  for (const [k, j] of jobs) if (j.refs === 0 && now - j.at > AGG_TTL) jobs.delete(k);
  let job = jobs.get(key) as AggJob<T> | undefined;
  if (!job) {
    job = new AggJob<T>(key, resource, specs, opts);
    jobs.set(key, job as AggJob<unknown>);
  }
  return job;
}

const EMPTY_AGG: Agg<never> = { key: '', items: [], done: 0, failed: [], fromCache: 0, refreshed: 0 };
const noSub = () => () => {};
const emptySnap = () => EMPTY_AGG;

/**
 * Queries every enabled addon serving `resource` (see the job above); results appear as each
 * answers. Waits for the id mapping first (AniList → Kitsu / MAL / IMDb + episode offsets).
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
  const ids = useAnimeIds(seriesId);
  const idsReady = ids !== undefined;
  const specs: JobSpec[] = idsReady && enabled
    ? list
        .filter((a) => a.enabled && (a.baseUrl !== builtin.baseUrl || resource === 'stream'))
        .map((a) => ({
          a,
          reqs: a.baseUrl === builtin.baseUrl ? [{ type: 'series', id: videoId(seriesId, episode) }] : requestsFor(a.manifest, resource, seriesId, episode, ids ?? null),
        }))
        .filter((j) => j.reqs.length > 0)
    : [];
  const key = idsReady && enabled
    ? `${resource}${variant ? `#${variant}` : ''}|${seriesId}|${episode}|${specs.map((j) => `${j.a.baseUrl}>${j.reqs.map((r) => `${r.type}/${r.id}`).join(',')}`).join('|')}`
    : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const job = useMemo(() => (key ? obtainJob<T>(key, resource, specs, opts) : null), [key]);
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
    pending: idsReady ? Math.max(0, specs.length - snap.done) : enabled ? 1 : 0,
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

export const getAddonByBase = (baseUrl: string) => state.addons.find((a) => a.baseUrl === baseUrl);
