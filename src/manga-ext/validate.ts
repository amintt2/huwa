// Strict normalization of what a sandboxed extension returns. The sandbox is untrusted: every
// field is type-checked, bounded, and every URL must be http(s). Anything else is dropped.
import { cleanHeaders, isBlockedHost, parseHttpUrl } from './net';
import type { PaperbackFormat } from './runtime/protocol';

export type ExtStatus = 'ongoing' | 'completed' | 'upcoming';

export type ExtManga = {
  mangaId: string;
  title: string;
  altTitles: string[];
  image?: string;
  banner?: string;
  synopsis: string;
  author?: string;
  artist?: string;
  status: ExtStatus;
  tags: string[];
  /** 0–10 */
  rating?: number;
  shareUrl?: string;
  adult: boolean;
  /** 0.9 only: the SourceManga to hand back to getChapters / getChapterDetails (bounded JSON). */
  sourceManga?: Record<string, unknown>;
};

export type ExtChapter = {
  chapterId: string;
  number: number;
  volume?: number;
  title?: string;
  lang: string;
  group?: string;
  /** ms since epoch */
  date?: number;
  sortingIndex?: number;
  /** 0.9 only: the chapter to hand back to getChapterDetails (without sourceManga, bounded JSON). */
  raw?: Record<string, unknown>;
};

export type ExtSearchItem = { mangaId: string; title: string; subtitle?: string; image?: string };
export type ExtSearchPage = { items: ExtSearchItem[]; next?: unknown };
export type ExtPages = { pages: string[] };

const MAX_CHAPTERS = 10_000;
const MAX_PAGES = 2_000;
const MAX_RAW = 64 * 1024;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

export function text(v: unknown, max = 300): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return '';
  return v
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‍⁠﻿]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

const FLAG_LANG: Record<string, string> = {
  gb: 'en', us: 'en', fr: 'fr', es: 'es', mx: 'es-la', br: 'pt-br', pt: 'pt', jp: 'ja', kr: 'ko', cn: 'zh', hk: 'zh-hk', tw: 'zh-hk',
  de: 'de', it: 'it', ru: 'ru', id: 'id', vn: 'vi', th: 'th', tr: 'tr', sa: 'ar', ph: 'tl', pl: 'pl', ua: 'uk', nl: 'nl', my: 'ms',
};

/** Language code, lowercased. Paperback 0.9 sources (MangaDex) sometimes return a flag emoji instead. */
export function normalizeLang(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  const cps = [...s].map((c) => c.codePointAt(0) ?? 0);
  if (cps.length === 2 && cps.every((c) => c >= 0x1f1e6 && c <= 0x1f1ff)) {
    const cc = String.fromCharCode(...cps.map((c) => c - 0x1f1e6 + 97));
    return FLAG_LANG[cc] ?? cc;
  }
  const code = s.toLowerCase().replace(/_/g, '-');
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(code) ? code : 'unknown';
}

/** http(s) URL or undefined. Spaces are escaped (some sources return raw file names). */
export function httpUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const url = v.trim().replace(/ /g, '%20');
  const p = parseHttpUrl(url);
  return p && !isBlockedHost(p.host) ? url : undefined;
}

const id = (v: unknown) => {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v : '';
  return s.length > 0 && s.length <= 512 ? s : undefined;
};

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

function boundedJson(v: unknown, max = MAX_RAW): Obj | undefined {
  try {
    const s = JSON.stringify(v);
    return s && s.length <= max ? (JSON.parse(s) as Obj) : undefined;
  } catch {
    return undefined;
  }
}

export function mapStatus(v: unknown): ExtStatus {
  const s = text(v, 60).toLowerCase();
  if (/complet|finish|ended|termin|done|cancel|abandon/.test(s)) return 'completed';
  if (/upcoming|announced|not.?yet|coming/.test(s)) return 'upcoming';
  return 'ongoing';
}

const decodeEntities = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, '’')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

function tagLabels(groups: unknown, format: PaperbackFormat): string[] {
  if (!Array.isArray(groups)) return [];
  const out: string[] = [];
  for (const g of groups.slice(0, 20)) {
    if (!isObj(g) || !Array.isArray(g.tags)) continue;
    for (const t of g.tags.slice(0, 60)) {
      const label = isObj(t) ? text(format === '0.9' ? (t.title ?? t.label) : (t.label ?? t.title), 40) : '';
      if (label && !out.includes(label)) out.push(label);
    }
  }
  return out.slice(0, 30);
}

export function normalizeDetails(format: PaperbackFormat, raw: unknown, mangaId: string): ExtManga {
  if (!isObj(raw) || !isObj(raw.mangaInfo)) throw new Error('Détails invalides');
  const info = raw.mangaInfo;
  const titles = format === '0.9'
    ? [text(info.primaryTitle, 200), ...(Array.isArray(info.secondaryTitles) ? info.secondaryTitles.map((t) => text(t, 200)) : [])]
    : Array.isArray(info.titles) ? info.titles.map((t) => text(t, 200)) : [];
  const unique = [...new Set(titles.filter(Boolean))];
  if (!unique.length) throw new Error('Titre manquant');
  const rating = num(info.rating ?? info.avgRating);
  const contentRating = format === '0.9' ? text(info.contentRating, 20) : '';
  const result: ExtManga = {
    mangaId,
    title: unique[0],
    altTitles: unique.slice(1, 20),
    image: httpUrl(format === '0.9' ? info.thumbnailUrl : info.image),
    banner: httpUrl(format === '0.9' ? info.bannerUrl : info.banner),
    synopsis: decodeEntities(text(format === '0.9' ? info.synopsis : info.desc, 4000)),
    author: text(info.author, 120) || undefined,
    artist: text(info.artist, 120) || undefined,
    status: mapStatus(info.status),
    tags: tagLabels(format === '0.9' ? info.tagGroups : info.tags, format),
    rating: rating === undefined ? undefined : Math.max(0, Math.min(10, rating > 10 ? rating / 10 : rating)),
    shareUrl: httpUrl(info.shareUrl),
    adult: format === '0.9' ? contentRating === 'ADULT' : info.hentai === true,
  };
  if (format === '0.9') {
    const sm = boundedJson({ ...raw, mangaId });
    if (!sm) throw new Error('Détails trop volumineux');
    result.sourceManga = sm;
  }
  return result;
}

export function normalizeChapters(format: PaperbackFormat, raw: unknown): ExtChapter[] {
  if (!Array.isArray(raw)) throw new Error('Liste de chapitres invalide');
  const out: ExtChapter[] = [];
  const seen = new Set<string>();
  for (const c of raw.slice(0, MAX_CHAPTERS)) {
    if (!isObj(c)) continue;
    const chapterId = id(format === '0.9' ? c.chapterId : (c.id ?? c.chapterId));
    if (!chapterId || seen.has(chapterId)) continue;
    seen.add(chapterId);
    const number = num(c.chapNum);
    const date = Date.parse(text(format === '0.9' ? (c.publishDate ?? c.creationDate) : c.time, 40));
    const ch: ExtChapter = {
      chapterId,
      number: number ?? NaN,
      volume: num(c.volume) || undefined,
      title: text(format === '0.9' ? c.title : c.name, 200) || undefined,
      lang: normalizeLang(c.langCode),
      group: text(format === '0.9' ? c.version : c.group, 120) || undefined,
      date: Number.isNaN(date) ? undefined : date,
      sortingIndex: num(c.sortingIndex),
    };
    if (format === '0.9') {
      const { sourceManga: _drop, ...rest } = c;
      const rawCh = boundedJson(rest, 8 * 1024);
      if (!rawCh) continue;
      ch.raw = rawCh;
    }
    out.push(ch);
  }
  return out;
}

export function normalizePages(format: PaperbackFormat, raw: unknown): ExtPages {
  if (!isObj(raw)) throw new Error('Chapitre invalide');
  if (format === '0.9' && raw.type && raw.type !== 'images') throw new Error('Chapitre au format roman ou fichier : non pris en charge');
  if (!Array.isArray(raw.pages)) throw new Error('Chapitre sans pages');
  const pages = raw.pages.slice(0, MAX_PAGES).map(httpUrl).filter((u): u is string => !!u);
  if (!pages.length) throw new Error('Aucune page lisible (URL http(s) attendues)');
  return { pages };
}

export function normalizeSearch(format: PaperbackFormat, raw: unknown): ExtSearchPage {
  if (!isObj(raw)) throw new Error('Résultats invalides');
  const list = format === '0.9' ? raw.items : (raw.results ?? raw.items);
  if (!Array.isArray(list)) throw new Error('Résultats invalides');
  const items: ExtSearchItem[] = [];
  const seen = new Set<string>();
  for (const r of list.slice(0, 200)) {
    if (!isObj(r)) continue;
    const mangaId = id(r.mangaId ?? r.id);
    const titleRaw = isObj(r.title) ? r.title.text : r.title;
    const title = text(titleRaw, 200);
    if (!mangaId || !title || seen.has(mangaId)) continue;
    seen.add(mangaId);
    const subRaw = r.subtitle ?? (isObj(r.subtitleText) ? r.subtitleText.text : undefined);
    items.push({ mangaId, title: decodeEntities(title), subtitle: text(subRaw, 120) || undefined, image: httpUrl(r.imageUrl ?? r.image) });
  }
  const next = raw.metadata == null ? undefined : boundedJson({ m: raw.metadata }, 16 * 1024)?.m;
  return { items, next };
}

export function normalizeImageHeaders(raw: unknown): Record<string, string> | undefined {
  if (!isObj(raw)) return undefined;
  const headers = cleanHeaders(raw.headers);
  // Only request headers that make sense for an image fetch.
  const allowed = Object.fromEntries(
    Object.entries(headers).filter(([k, v]) => /^(referer|origin|user-agent|cookie|accept|accept-language|authorization|x-[a-z0-9-]+)$/i.test(k) && v.length <= 4096),
  );
  return Object.keys(allowed).length ? allowed : undefined;
}
