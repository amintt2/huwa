// Home of an installed source (Paperback "Discover" on 0.9, home page sections on 0.8): its
// sections and their items, fetched lazily and kept for the session (a source home doesn't
// change every minute and each call wakes its sandbox).
import { useEffect, useSyncExternalStore } from 'react';

import { sourceImageHeaders } from './api';
import { callSource } from './bridge';
import { isCloudflareError, sourceErrorText as errorText } from './cloudflare-core';
import { getInstalled } from './registry';
import { normalizeSectionItems, normalizeSections, type ExtSearchItem, type ExtSearchPage, type ExtSection } from './validate';

/** A Cloudflare check is needed (page to open, when known). */
export type Blocked = { url?: string };
export type SectionState = { state: 'loading' | 'ok' | 'error'; items: ExtSearchItem[]; next?: unknown; error?: string; blocked?: Blocked };
export type SourceHome = {
  state: 'idle' | 'loading' | 'ok' | 'error';
  sections: ExtSection[];
  rows: Record<string, SectionState>;
  imageHeaders?: Record<string, string>;
  error?: string;
  blocked?: Blocked;
  at: number;
};

const TTL = 30 * 60e3;
const ROW_CONCURRENCY = 3;
const EMPTY: SourceHome = { state: 'idle', sections: [], rows: {}, at: 0 };

const homes = new Map<string, SourceHome>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const cacheKey = (key: string) => `${key}@${getInstalled(key)?.version ?? ''}`;

function set(key: string, next: Partial<SourceHome>) {
  const k = cacheKey(key);
  homes.set(k, { ...(homes.get(k) ?? EMPTY), ...next });
  emit();
}
function setRow(key: string, id: string, row: SectionState) {
  const cur = homes.get(cacheKey(key)) ?? EMPTY;
  set(key, { rows: { ...cur.rows, [id]: row } });
}

function formatOf(key: string) {
  const s = getInstalled(key);
  if (!s) throw new Error('Source non installée');
  return s.format;
}

/** One page of a section ("Voir tout" and 0.9 rows). */
export async function sectionPage(key: string, section: ExtSection, next?: unknown): Promise<ExtSearchPage> {
  const format = formatOf(key);
  const arg = format === '0.9' ? (section.raw ?? { id: section.id }) : section.id;
  return normalizeSectionItems(format, await callSource(key, 'discoverItems', [arg, next ?? null]));
}

async function warmHeaders(key: string, items: ExtSearchItem[]) {
  const sample = items.find((i) => i.image)?.image;
  if (!sample || homes.get(cacheKey(key))?.imageHeaders) return;
  const headers = await sourceImageHeaders(key, sample);
  if (headers) set(key, { imageHeaders: headers });
}

/** Loads (once per session, or when stale) the sections of a source and their first items. */
export async function loadSourceHome(key: string, force = false) {
  const cur = homes.get(cacheKey(key));
  if (!force && cur && (cur.state === 'loading' || (cur.state === 'ok' && Date.now() - cur.at < TTL))) return;
  set(key, { state: 'loading', error: undefined, blocked: undefined, ...(force ? { rows: {} } : {}) });
  try {
    const format = formatOf(key);
    const sections = normalizeSections(format, await callSource(key, 'discover', [], 90_000)).filter((s) => s.kind !== 'genres');
    const rows: Record<string, SectionState> = {};
    for (const s of sections) rows[s.id] = s.items ? { state: 'ok', items: s.items } : { state: 'loading', items: [] };
    set(key, { state: 'ok', sections, rows, at: Date.now() });
    const inline = sections.flatMap((s) => s.items ?? []);
    if (inline.length) warmHeaders(key, inline).catch(() => {});
    // 0.9: items per section, a few at a time (each is a page load on the source's site).
    const queue = sections.filter((s) => !s.items);
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        try {
          const page = await sectionPage(key, s);
          setRow(key, s.id, { state: 'ok', items: page.items, next: page.next });
          warmHeaders(key, page.items).catch(() => {});
        } catch (e) {
          setRow(key, s.id, { state: 'error', items: [], error: errorText(e), blocked: isCloudflareError(e) ? { url: e.url } : undefined });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ROW_CONCURRENCY, queue.length) }, worker));
  } catch (e) {
    set(key, { state: 'error', error: errorText(e), blocked: isCloudflareError(e) ? { url: e.url } : undefined });
  }
}


export const getSourceHome = (key: string) => homes.get(cacheKey(key)) ?? EMPTY;
export const getSection = (key: string, id: string) => getSourceHome(key).sections.find((s) => s.id === id);

/** Home of a source; starts loading it on first use. */
export function useSourceHome(key: string | null): SourceHome {
  const home = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (key ? getSourceHome(key) : EMPTY),
    () => (key ? getSourceHome(key) : EMPTY),
  );
  useEffect(() => {
    if (key) loadSourceHome(key).catch(() => {});
  }, [key]);
  return home;
}
