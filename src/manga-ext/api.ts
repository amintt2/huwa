// Typed, validated calls to installed sources.
import { callSource } from './bridge';
import { userAgentFor } from './clearance';
import { parseHttpUrl } from './net';
import { getInstalled } from './registry';
import { jarFor } from './state';
import {
  normalizeChapters,
  normalizeDetails,
  normalizeImageHeaders,
  normalizePages,
  normalizeSearch,
  type ExtChapter,
  type ExtManga,
  type ExtSearchPage,
} from './validate';

function formatOf(key: string) {
  const s = getInstalled(key);
  if (!s) throw new Error('Source non installée');
  return s.format;
}

export async function searchSource(key: string, title: string, next?: unknown): Promise<ExtSearchPage> {
  const format = formatOf(key);
  return normalizeSearch(format, await callSource(key, 'search', [title.slice(0, 200), next ?? null]));
}

export async function mangaDetails(key: string, mangaId: string): Promise<ExtManga> {
  const format = formatOf(key);
  return normalizeDetails(format, await callSource(key, 'details', [mangaId]), mangaId);
}

/** 0.9 sources need the SourceManga returned by the details call. */
export async function mangaChapters(key: string, manga: Pick<ExtManga, 'mangaId' | 'sourceManga'>): Promise<ExtChapter[]> {
  const format = formatOf(key);
  const arg = format === '0.9' ? (manga.sourceManga ?? { mangaId: manga.mangaId }) : manga.mangaId;
  return normalizeChapters(format, await callSource(key, 'chapters', [arg], 90_000));
}

export type ChapterPages = { pages: string[]; headers?: Record<string, string> };

export async function chapterPages(
  key: string,
  manga: Pick<ExtManga, 'mangaId' | 'sourceManga'>,
  chapter: Pick<ExtChapter, 'chapterId' | 'raw'>,
): Promise<ChapterPages> {
  const format = formatOf(key);
  const args = format === '0.9' ? [chapter.raw ?? { chapterId: chapter.chapterId }, manga.sourceManga ?? { mangaId: manga.mangaId }] : [manga.mangaId, chapter.chapterId];
  const { pages } = normalizePages(format, await callSource(key, 'pages', args));
  // Headers the source's interceptor adds to image requests (Referer, cookies…), computed on the first page.
  let headers: Record<string, string> | undefined;
  try {
    headers = normalizeImageHeaders(await callSource(key, 'imageHeaders', [pages[0]], 15_000));
  } catch {
    headers = undefined;
  }
  const target = parseHttpUrl(pages[0]);
  const jarCookies = target ? jarFor(key).header(target) : '';
  if (jarCookies) {
    const h = { ...headers };
    const k = Object.keys(h).find((x) => x.toLowerCase() === 'cookie');
    h[k ?? 'Cookie'] = k ? `${jarCookies}; ${h[k]}` : jarCookies;
    headers = h;
  }
  // Images behind a Cloudflare clearance need the User-Agent it was issued for.
  const ua = target ? userAgentFor(target.host) : undefined;
  if (ua) {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() !== 'user-agent') h[k] = v;
    headers = { ...h, 'User-Agent': ua };
  }
  return { pages, headers };
}

const coverHeaderCache = new Map<string, Promise<Record<string, string> | undefined>>();
/** Headers a source adds to its image requests (covers from sites that check the Referer). Cached per source. */
export function sourceImageHeaders(key: string, sampleUrl: string): Promise<Record<string, string> | undefined> {
  let p = coverHeaderCache.get(key);
  if (!p) {
    p = callSource(key, 'imageHeaders', [sampleUrl], 15_000).then(normalizeImageHeaders, () => undefined);
    coverHeaderCache.set(key, p);
  }
  return p;
}
