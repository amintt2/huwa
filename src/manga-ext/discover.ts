// Home of an installed source (Paperback "Discover" on 0.9, home page sections on 0.8): its
// sections and their items, fetched lazily, kept for the session and saved on disk (a source home
// doesn't change every minute and each call wakes its sandbox).
import { useEffect, useSyncExternalStore } from 'react';

import { cache as swrCache } from '@/data/swr';

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

/** What is kept on disk of a source home (no image headers: they may carry cookies). */
type Snapshot = { sections: ExtSection[]; rows: Record<string, SectionState> };
const diskKey = (key: string) => `source-home:${cacheKey(key)}`;

/** Last home saved for this source and version, shown while the sandbox wakes up. */
async function restore(key: string): Promise<boolean> {
  const hit = await swrCache.get<Snapshot>(diskKey(key)).catch(() => undefined);
  if (!hit || homes.get(cacheKey(key))?.state === 'ok') return false;
  set(key, { state: 'ok', sections: hit.value.sections, rows: hit.value.rows, at: hit.at });
  warmHeaders(key, Object.values(hit.value.rows).flatMap((r) => r.items)).catch(() => {});
  return true;
}

function save(key: string) {
  const home = homes.get(cacheKey(key));
  if (!home || home.state !== 'ok') return;
  const rows = Object.fromEntries(
    Object.entries(home.rows)
      .filter(([, r]) => r.state === 'ok')
      .map(([id, r]) => [id, { state: 'ok' as const, items: r.items, next: r.next }]),
  );
  if (!Object.keys(rows).length) return;
  swrCache.set<Snapshot>(diskKey(key), { sections: home.sections, rows }).catch(() => {});
}

/**
 * Loads the sections of a source and their first items. Stale-while-revalidate: the home saved by
 * the last visit shows at once (data/swr.ts), the source is asked again when it is older than
 * 30 min, and each row keeps its old items until the new ones arrive.
 */
export async function loadSourceHome(key: string, force = false) {
  let cur = homes.get(cacheKey(key));
  if (!force && cur?.state === 'loading') return;
  if (!cur && (await restore(key))) cur = homes.get(cacheKey(key));
  if (!force && cur && cur.state === 'ok' && Date.now() - cur.at < TTL) return;
  const shown = !!cur && cur.state === 'ok' && cur.sections.length > 0;
  const before = shown ? cur!.rows : {};
  // With something on screen, the refresh happens underneath (no skeleton, no spinner).
  if (!shown) set(key, { state: 'loading', error: undefined, blocked: undefined, ...(force ? { rows: {} } : {}) });
  try {
    const format = formatOf(key);
    const sections = normalizeSections(format, await callSource(key, 'discover', [], 90_000)).filter((s) => s.kind !== 'genres');
    const rows: Record<string, SectionState> = {};
    for (const s of sections) {
      rows[s.id] = s.items ? { state: 'ok', items: s.items } : before[s.id]?.state === 'ok' ? before[s.id] : { state: 'loading', items: [] };
    }
    set(key, { state: 'ok', sections, rows, at: Date.now(), error: undefined, blocked: undefined });
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
          // A row shown from the last visit stays when its refresh fails.
          if (before[s.id]?.state === 'ok') continue;
          setRow(key, s.id, { state: 'error', items: [], error: errorText(e), blocked: isCloudflareError(e) ? { url: e.url } : undefined });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ROW_CONCURRENCY, queue.length) }, worker));
    save(key);
  } catch (e) {
    // Offline or blocked with an old home on screen: keep it.
    if (shown) set(key, { state: 'ok' });
    else set(key, { state: 'error', error: errorText(e), blocked: isCloudflareError(e) ? { url: e.url } : undefined });
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
