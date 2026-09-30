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

import { chapterPages, mangaChapters, mangaDetails, sourceImageHeaders, type ChapterPages } from './api';
import { shortHash } from './b64';
import { buildChapters, pickLang, titlesMatch, type MatchTitles, type StoredChapter } from './chapters';
import { getInstalled, onSourceRemoved } from './registry';
import type { ExtChapter, ExtManga } from './validate';

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

// ---------- AniList matching ----------

async function matchAniList(m: ExtManga): Promise<Series | null> {
  const query = `query ($s: String) { Page(perPage: 8) { media(type: MANGA, search: $s) {
    ${NODE} title { romaji native } synonyms relations { edges { relationType(version: 2) node { ${NODE} } } } } } }`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const data = await gql<{ Page: { media: (Media & MatchTitles)[] } }>(query, { s: m.title.slice(0, 120) }, { signal: ctrl.signal });
    const hit = data.Page.media.find((x) => titlesMatch([m.title, ...m.altTitles], x));
    if (!hit) return null;
    const adaptation =
      hit.relations?.edges.find((e) => e.relationType === 'ADAPTATION' && e.node.type === 'ANIME' && episodeCount(e.node) > 0)?.node ?? null;
    const s = build(adaptation, hit, 999);
    return s ? { ...s, author: m.author ?? (hit.countryOfOrigin === 'KR' ? s.author : 'Manga') } : null;
  } catch {
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
 * Opens a series of an installed source: details, AniList match, chapters. Returns the Huwa
 * series id to navigate to (`/manhwa/<id>`).
 */
export async function openSourceManga(key: string, mangaId: string, opts: { seriesId?: string } = {}): Promise<string> {
  const details = await mangaDetails(key, mangaId);
  const known = Object.values(links).find((l) => l.key === key && l.mangaId === mangaId);
  let seriesId = opts.seriesId ?? known?.seriesId;
  let anilist = seriesId ? !seriesId.startsWith('px') : false;
  if (!seriesId) {
    const matched = await matchAniList(details);
    const series = matched ?? standalone(key, details);
    if (!getSeries(series.id)) registerSeries([series]);
    seriesId = series.id;
    anilist = !!matched;
  }
  const chapters = await mangaChapters(key, details);
  if (!chapters.length) throw new Error('Aucun chapitre dans cette source');
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

/** Re-fetches the chapter list of a linked series. */
export async function refreshLinked(seriesId: string) {
  const link = links[seriesId];
  if (!link) return;
  let sourceManga = link.sourceManga;
  if (getInstalled(link.key)?.format === '0.9' && !sourceManga) sourceManga = (await mangaDetails(link.key, link.mangaId)).sourceManga;
  const chapters = await mangaChapters(link.key, { mangaId: link.mangaId, sourceManga });
  if (chapters.length) await storeChapters({ ...link, sourceManga }, chapters);
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

/** Pages of a chapter coming from a source ([] when the chapter isn't from a source). */
async function fetchPages(chapterId: string): Promise<{ pages: string[]; headers?: Record<string, string> }> {
  const ref = chapterIndex.get(chapterId);
  const link = ref && links[ref.seriesId];
  if (!ref || !link) return { pages: [] };
  // Keyed by the source chapter too: switching language maps the same Huwa id to another chapter.
  const cacheKey = `${link.key}|${ref.chapter.chapterId}`;
  const hit = pageCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PAGE_TTL) return hit.value;
  const value = chapterPages(link.key, { mangaId: link.mangaId, sourceManga: link.sourceManga }, ref.chapter);
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
    registerPageSource({ id: 'paperback', name: 'Extensions', fetchPages });
    onSourceRemoved((key) => {
      for (const l of Object.values(links)) if (l.key === key) unlink(l.seriesId);
    });
  })();
  return hydration;
}
