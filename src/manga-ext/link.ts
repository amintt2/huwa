// Ties a series from an installed source to Huwa:
// - the source series is matched to its AniList page when a title matches (the anime ↔ chapter
//   bridge keeps working with the real chapters), otherwise it gets its own page (`px…` id);
// - its real chapters replace the placeholders of that page (`setChapterOverlay`);
// - the reader gets the pages through `registerPageSource`, with the source's image headers.
// Chapter ids stay `<seriesId>-c<number>` so progress on the AniList page is kept.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { registerPageSource } from '@/components/reader/pageSource';
import { build, episodeCount, NODE, palette, type Media } from '@/data/anilist';
import { gql } from '@/data/anilist-api';
import { getSeries, registerSeries, setChapterOverlay, type Chapter, type Series } from '@/data/catalog';
import { getSettings } from '@/settings/settings';
import { getState as getStore, removeFromHistory, restoreHistory, toggleMyList } from '@/store/store';

import { chapterPages, mangaChapters, mangaDetails, sourceImageHeaders, type ChapterPages } from './api';
import { shortHash } from './b64';
import { buildChapters, pickLang, type MatchTitles, type StoredChapter } from './chapters';
import { withCloudflare } from './cloudflare';
import { pickCatalogMatch, searchQueries, splitAltTitles, type CatalogCandidate } from './match';
import { getInstalled, onSourceRemoved } from './registry';
import type { ExtChapter, ExtManga } from './validate';
import { registerRehydrate } from '@/settings/rehydrate';

export type SourceLink = {
  seriesId: string;
  key: string;
  mangaId: string;
  title: string;
  /** 0.9 SourceManga, handed back to the source for chapters and pages. */
  sourceManga?: Record<string, unknown>;
  lang: string;
  langs: string[];
  anilist: boolean;
  /** Headers for the source's images (cover of a standalone page). */
  imageHeaders?: Record<string, string>;
  updatedAt: number;
};


const LINKS_KEY = 'huwa/pb/links/v1';
const chaptersKey = (seriesId: string) => `huwa/pb/chapters/${seriesId}`;
const PAGE_TTL = 20 * 60e3;

let links: Record<string, SourceLink> = {};
const chapterIndex = new Map<string, { seriesId: string; chapter: StoredChapter }>();
const pageCache = new Map<string, { at: number; value: Promise<ChapterPages> }>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const saveLinks = () => AsyncStorage.setItem(LINKS_KEY, JSON.stringify(links)).catch(() => {});

export const useSourceLink = (seriesId: string) =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => links[seriesId],
    () => links[seriesId],
  );
export const getSourceLink = (seriesId: string) => links[seriesId];

/** Every linked series, most recently refreshed first ("Dans tes sources"). Stable between changes. */
let linkedCache: { from: Record<string, SourceLink>; list: SourceLink[] } = { from: {}, list: [] };
const linkedList = () => {
  if (linkedCache.from !== links) linkedCache = { from: links, list: Object.values(links).sort((a, b) => b.updatedAt - a.updatedAt) };
  return linkedCache.list;
};
export const useLinkedSeries = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    linkedList,
    linkedList,
  );

/**
 * Link of a catalog tile: by id, or through its AniList manga id (a title opened from a source
 * may live on its anime page `al…` while the manhwa catalog shows `alm…`).
 */
export function linkForTile(links: SourceLink[], s: { id: string; manhwaId?: number }): SourceLink | undefined {
  return links.find((l) => l.seriesId === s.id || (s.manhwaId !== undefined && getSeries(l.seriesId)?.manhwaId === s.manhwaId));
}

// ---------- chapters ----------

function toCatalog(seriesId: string, list: StoredChapter[]): Chapter[] {
  const now = Date.now();
  return list.map((c) => ({
    id: c.id,
    seriesId,
    number: c.number,
    title: c.title ?? '',
    releasedDaysAgo: c.date ? Math.max(0, Math.floor((now - c.date) / 86_400_000)) : -1,
    pageCount: 0,
  }));
}

function applyChapters(seriesId: string, list: StoredChapter[]) {
  for (const [id, v] of chapterIndex) if (v.seriesId === seriesId) chapterIndex.delete(id);
  for (const c of list) chapterIndex.set(c.id, { seriesId, chapter: c });
  setChapterOverlay(seriesId, toCatalog(seriesId, list));
}

async function storeChapters(link: SourceLink, all: ExtChapter[]) {
  const lang = pickLang(all, link.lang, getSettings().lang, getSettings().mangaLangs);
  const langs = [...new Set(all.map((c) => c.lang))];
  const list = buildChapters(link.seriesId, all, lang);
  const next: SourceLink = { ...link, lang, langs, updatedAt: Date.now() };
  links = { ...links, [link.seriesId]: next };
  applyChapters(link.seriesId, list);
  emit();
  saveLinks();
  // Every language is kept so switching language doesn't need the network.
  await AsyncStorage.setItem(chaptersKey(link.seriesId), JSON.stringify(all)).catch(() => {});
  return next;
}

// ---------- AniList matching (source title → catalog page) ----------

type AniMedia = Media & MatchTitles & { relations?: { edges: { relationType: string; node: Media }[] } };
const MATCH_QUERY = `query ($s: String) { Page(perPage: 8) { media(type: MANGA, search: $s) {
  ${NODE} title { romaji native } synonyms relations { edges { relationType(version: 2) node { ${NODE} } } } } } }`;

/** Catalog ids a source title was refused for ("Ce n'est pas le bon"), set by `autolink.ts`. */
let rejectedFor: (ref: string) => Promise<Set<string>> = async () => new Set();
export function setRejectedLookup(fn: (ref: string) => Promise<Set<string>>) {
  rejectedFor = fn;
}

const adaptationOf = (m: AniMedia) =>
  m.relations?.edges.find((e) => e.relationType === 'ADAPTATION' && e.node.type === 'ANIME' && episodeCount(e.node) > 0)?.node ?? null;

function asCandidate(m: AniMedia): CatalogCandidate {
  const titles = [m.title.english, m.title.romaji, m.title.userPreferred, ...(m.synonyms ?? []).slice(0, 10), m.title.native].filter(
    (t): t is string => !!t && t.trim().length > 1,
  );
  return { id: `alm${m.id}`, titles: [...new Set(titles)], chapters: m.chapters ?? null, finished: m.status === 'FINISHED' || m.status === 'CANCELLED' };
}

/** The Huwa series of an AniList entry (anime-adapted ones get the anime page, as everywhere else). */
export function seriesFromMedia(hit: AniMedia, author?: string): Series | null {
  const s = build(adaptationOf(hit), hit, 999);
  return s ? { ...s, author: author ?? (hit.countryOfOrigin === 'KR' ? s.author : 'Manga') } : null;
}

/** AniList manga search for "Associer à une fiche Huwa". */
export async function searchCatalog(q: string, signal?: AbortSignal): Promise<{ media: AniMedia; series: Series }[]> {
  const data = await gql<{ Page: { media: AniMedia[] } }>(MATCH_QUERY, { s: q.slice(0, 120) }, { signal });
  return data.Page.media.flatMap((m) => {
    const series = seriesFromMedia(m);
    return series ? [{ media: m, series }] : [];
  });
}

/** Ids a catalog entry may have in Huwa (manga page, or the page of its anime adaptation). */
const idsOf = (m: AniMedia) => [`alm${m.id}`, ...(adaptationOf(m) ? [`al${adaptationOf(m)!.id}`] : [])];

/**
 * Finds the AniList entry of a source title: searched by its titles (main, then alternative
 * ones, split when the source lists several in one string), scored with every AniList title and
 * synonym, checked against the source's chapter count. `null` when not confident (or refused).
 */
async function matchAniList(key: string, m: ExtManga, chapterCount: number): Promise<Series | null> {
  const titles = splitAltTitles([m.title, ...m.altTitles]);
  const rejected = await rejectedFor(`${key}|${m.mangaId}`).catch(() => new Set<string>());
  const seen = new Map<number, AniMedia>();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    for (const q of searchQueries(titles, 3)) {
      try {
        const data = await gql<{ Page: { media: AniMedia[] } }>(MATCH_QUERY, { s: q }, { signal: ctrl.signal });
        for (const x of data.Page.media) seen.set(x.id, x);
      } catch {
        if (ctrl.signal.aborted) break;
        continue;
      }
      const media = [...seen.values()];
      // A refused pair is refused under any of the entry's ids.
      const refused = new Set(media.filter((x) => idsOf(x).some((id) => rejected.has(id))).map((x) => `alm${x.id}`));
      const pick = pickCatalogMatch(titles, chapterCount, media.map(asCandidate), refused);
      if (pick) {
        const hit = media.find((x) => `alm${x.id}` === pick.id)!;
        // Already linked under one of its ids (e.g. its anime page): reuse that page.
        const existing = idsOf(hit).find((id) => getSeries(id)?.manhwa);
        return (existing ? getSeries(existing) : null) ?? seriesFromMedia(hit, m.author);
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function standalone(key: string, m: ExtManga): Series {
  return {
    id: `px${shortHash(`${key}|${m.mangaId}`)}`,
    title: m.title,
    synopsis: m.synopsis,
    genres: m.tags.slice(0, 3),
    year: 0,
    rating: m.rating ?? 0,
    palette: palette(null),
    author: [m.author, m.artist && m.artist !== m.author ? m.artist : ''].filter(Boolean).join(' · ') || getInstalled(key)?.name || 'Source',
    status: m.status,
    image: m.image,
    banner: m.banner,
    manhwa: { chapters: [] },
  };
}

// ---------- public API ----------

/**
 * Opens a series of an installed source: details, chapters, AniList match. Returns the Huwa series
 * id to navigate to (`/manhwa/<id>`): its AniList page when the match is confident, else a page of
 * the source only (`px…`). `interactive`: the user is waiting (a Cloudflare check may be asked).
 */
export async function openSourceManga(key: string, mangaId: string, opts: { seriesId?: string; interactive?: boolean } = {}): Promise<string> {
  const cf = <T,>(run: () => Promise<T>) => withCloudflare(run, !!opts.interactive);
  const details = await cf(() => mangaDetails(key, mangaId));
  const chapters = await cf(() => mangaChapters(key, details));
  if (!chapters.length) throw new Error('Aucun chapitre dans cette source');
  const known = Object.values(links).find((l) => l.key === key && l.mangaId === mangaId);
  let seriesId = opts.seriesId ?? (known && getSeries(known.seriesId)?.manhwa ? known.seriesId : undefined);
  let anilist = seriesId ? !seriesId.startsWith('px') : false;
  if (!seriesId) {
    const matched = await matchAniList(key, details, new Set(chapters.map((c) => `${c.lang}|${c.number}`)).size).catch(() => null);
    const series = matched ?? standalone(key, details);
    if (!getSeries(series.id)) registerSeries([series]);
    seriesId = series.id;
    anilist = !!matched;
  }
  const imageHeaders = details.image ? await sourceImageHeaders(key, details.image) : undefined;
  const prev = links[seriesId];
  await storeChapters(
    {
      seriesId,
      key,
      mangaId,
      title: details.title,
      sourceManga: details.sourceManga,
      lang: prev?.key === key ? prev.lang : '',
      langs: [],
      anilist,
      imageHeaders,
      updatedAt: Date.now(),
    },
    chapters,
  );
  return seriesId;
}

/**
 * "Associer à une fiche Huwa": moves the source link of a page (a source-only `px…` page, or a
 * wrong AniList page) to another catalog series. Reading progress follows (same chapter numbers),
 * and so does "Ma liste".
 */
export async function moveLink(fromSeriesId: string, to: Series) {
  const link = links[fromSeriesId];
  if (!link) throw new Error('Cette page n’est liée à aucune source');
  if (to.id === fromSeriesId) return to.id;
  if (!getSeries(to.id)) registerSeries([to]);
  const raw = await AsyncStorage.getItem(chaptersKey(fromSeriesId));
  const all = raw ? (JSON.parse(raw) as ExtChapter[]) : [];
  const progress = removeFromHistory(fromSeriesId, 'manhwa');
  await storeChapters({ ...link, seriesId: to.id, anilist: !to.id.startsWith('px'), lang: link.lang }, all);
  const prefix = `${fromSeriesId}-`;
  const moved: typeof progress.chapters = {};
  for (const [id, v] of Object.entries(progress.chapters)) moved[id.startsWith(prefix) ? `${to.id}-${id.slice(prefix.length)}` : id] = v;
  restoreHistory({ episodes: {}, chapters: moved });
  const list = getStore().myList;
  if (list.includes(fromSeriesId)) {
    toggleMyList(fromSeriesId);
    if (!list.includes(to.id)) toggleMyList(to.id);
  }
  unlink(fromSeriesId);
  return to.id;
}

/** Re-fetches the chapter list of a linked series. */
export async function refreshLinked(seriesId: string) {
  const link = links[seriesId];
  if (!link) return;
  let sourceManga = link.sourceManga;
  if (getInstalled(link.key)?.format === '0.9' && !sourceManga) sourceManga = (await mangaDetails(link.key, link.mangaId)).sourceManga;
  const chapters = await mangaChapters(link.key, { mangaId: link.mangaId, sourceManga });
  if (chapters.length) await storeChapters({ ...link, sourceManga }, chapters);
}

/** Same as `refreshLinked`, asking for a Cloudflare check when the site blocks it (user tapped "Actualiser"). */
export function refreshLinkedInteractive(seriesId: string) {
  return withCloudflare(() => refreshLinked(seriesId), true);
}

export async function setLinkLang(seriesId: string, lang: string) {
  const link = links[seriesId];
  if (!link) return;
  const raw = await AsyncStorage.getItem(chaptersKey(seriesId));
  const all = raw ? (JSON.parse(raw) as ExtChapter[]) : [];
  await storeChapters({ ...link, lang }, all);
}

export function unlink(seriesId: string) {
  const { [seriesId]: _gone, ...rest } = links;
  links = rest;
  for (const [id, v] of chapterIndex) if (v.seriesId === seriesId) chapterIndex.delete(id);
  setChapterOverlay(seriesId, undefined);
  emit();
  saveLinks();
  AsyncStorage.removeItem(chaptersKey(seriesId)).catch(() => {});
}

/** What a Huwa chapter id currently points to: source, manga, source chapter and its language. */
const provenanceOf = (link: SourceLink, chapter: StoredChapter) => JSON.stringify([link.key, link.mangaId, chapter.chapterId, chapter.lang]);

function chapterProvenance(chapterId: string): string | undefined {
  const ref = chapterIndex.get(chapterId);
  const link = ref && links[ref.seriesId];
  return ref && link ? provenanceOf(link, ref.chapter) : undefined;
}

/** Pages of a chapter coming from a source ([] when the chapter isn't from a source). */
async function fetchPages(chapterId: string): Promise<{ pages: string[]; headers?: Record<string, string> }> {
  const ref = chapterIndex.get(chapterId);
  const link = ref && links[ref.seriesId];
  if (!ref || !link) return { pages: [] };
  // Keyed by manga and source chapter: chapter ids are only unique within a manga for many
  // sources, and switching language maps the same Huwa id to another chapter.
  const cacheKey = provenanceOf(link, ref.chapter);
  const hit = pageCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PAGE_TTL) return hit.value;
  // The reader is waiting: a Cloudflare block opens the check, then the pages are fetched again.
  const value = withCloudflare(() => chapterPages(link.key, { mangaId: link.mangaId, sourceManga: link.sourceManga }, ref.chapter), true);
  pageCache.set(cacheKey, { at: Date.now(), value });
  value.catch(() => pageCache.delete(cacheKey));
  if (pageCache.size > 30) pageCache.delete(pageCache.keys().next().value!);
  return value;
}

export const isSourceChapter = (chapterId: string) => chapterIndex.has(chapterId);

let hydration: Promise<void> | undefined;
/** Restores links and their chapters (before the catalog is shown), and plugs the page source. */
export function hydrateLinks() {
  hydration ??= (async () => {
    await loadLinks();
    registerPageSource({ id: 'paperback', name: 'Extensions', fetchPages, provenance: chapterProvenance });
    onSourceRemoved((key) => {
      for (const l of Object.values(links)) if (l.key === key) unlink(l.seriesId);
    });
  })();
  return hydration;
}

// After a data import: drop the chapters of the old links, read the imported ones.
registerRehydrate(async () => {
  if (!hydration) return;
  await hydration;
  for (const seriesId of Object.keys(links)) applyChapters(seriesId, []);
  await loadLinks();
});

async function loadLinks() {
  try {
    const raw = await AsyncStorage.getItem(LINKS_KEY);
    links = raw ? (JSON.parse(raw) as Record<string, SourceLink>) : {};
  } catch {
    links = {};
  }
  await Promise.all(
    Object.values(links).map(async (l) => {
      try {
        const raw = await AsyncStorage.getItem(chaptersKey(l.seriesId));
        const all = raw ? (JSON.parse(raw) as ExtChapter[]) : [];
        applyChapters(l.seriesId, buildChapters(l.seriesId, all, l.lang));
      } catch {
        // chapters will be fetched again on the series page
      }
    }),
  );
  emit();
}
