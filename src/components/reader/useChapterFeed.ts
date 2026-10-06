// Loaded window of consecutive chapters for the continuous reader (see `feed.ts`).
// The anchor chapter loads first; the next one is appended when the reader nears the end of the
// window, the previous one prepended when it scrolls back past the top. Chapters further than one
// from the current one are dropped (memory stays bounded on long sessions).
import { useEffect, useRef, useState } from 'react';

import { getChapter, type Chapter } from '@/data/catalog';

import { keepAround, type Segment } from './feed';
import { onPageSourcesChange } from './pageSource';
import { resolvePages } from './pages';
import { readerReady } from './position';

export type LoadState = { status: 'loading' } | { status: 'error'; error?: string };

/** Chapters of the series in reading order (by position: numbers can be 12.5 or skip). */
export function chapterList(chapterId: string): Chapter[] {
  return getChapter(chapterId)?.series.manhwa?.chapters ?? [];
}

export function neighbours(chapterId: string): { prev?: Chapter; next?: Chapter } {
  const list = chapterList(chapterId);
  const at = list.findIndex((c) => c.id === chapterId);
  if (at < 0) return {};
  return { prev: list[at - 1], next: list[at + 1] };
}

export function useChapterFeed(anchorId: string) {
  const [segments, setSegments] = useState<Segment[]>([]);
  /** Chapters being fetched, or that failed (absent = idle or loaded). */
  const [loads, setLoads] = useState<Record<string, LoadState>>({ [anchorId]: { status: 'loading' } });
  const inflight = useRef(new Set<string>());
  const alive = useRef(true);
  const segsRef = useRef(segments);
  /** Page sources changed while placeholder pages are shown: the reader should restart. */
  const [stale, setStale] = useState(false);
  useEffect(() => {
    segsRef.current = segments;
  }, [segments]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = (chapterId: string, where: 'anchor' | 'prev' | 'next') => {
    if (inflight.current.has(chapterId) || segsRef.current.some((s) => s.chapterId === chapterId)) return;
    inflight.current.add(chapterId);
    setLoads((l) => ({ ...l, [chapterId]: { status: 'loading' } }));
    (async () => {
      await readerReady;
      const r = await resolvePages(chapterId).catch((e: unknown) => ({ pages: [] as string[], origin: 'placeholder' as const, error: e instanceof Error ? e.message : String(e) }));
      inflight.current.delete(chapterId);
      if (!alive.current) return;
      if (!r.pages.length) {
        setLoads((l) => ({ ...l, [chapterId]: { status: 'error', error: r.error } }));
        return;
      }
      const seg: Segment = { chapterId, pages: r.pages, headers: 'headers' in r ? r.headers : undefined, origin: r.origin, sourceName: 'sourceName' in r ? r.sourceName : undefined };
      setSegments((cur) => {
        if (cur.some((s) => s.chapterId === chapterId)) return cur;
        if (where === 'anchor' || !cur.length) return [seg];
        // Only attach to a matching end: the window may have moved while this was loading.
        if (where === 'next' && neighbours(cur[cur.length - 1].chapterId).next?.id === chapterId) return [...cur, seg];
        if (where === 'prev' && neighbours(cur[0].chapterId).prev?.id === chapterId) return [seg, ...cur];
        return cur;
      });
      setLoads((l) => {
        const { [chapterId]: _done, ...rest } = l;
        return rest;
      });
    })();
  };

  useEffect(() => {
    load(anchorId, 'anchor');
  }, [anchorId]);

  // Sources registered late (app start): demo placeholders are replaced by real pages.
  useEffect(
    () =>
      onPageSourcesChange(() => {
        if (segsRef.current.some((s) => s.origin === 'placeholder') || !segsRef.current.length) setStale(true);
      }),
    [],
  );

  const first = segments[0]?.chapterId;
  const last = segments[segments.length - 1]?.chapterId;

  return {
    segments,
    stale,
    loads,
    /** Chapter before the window / after it, in catalog order. */
    prevOf: first ? neighbours(first).prev : undefined,
    nextOf: last ? neighbours(last).next : undefined,
    loadNext: () => {
      const n = last && neighbours(last).next;
      if (n && loads[n.id]?.status !== 'error') load(n.id, 'next');
    },
    loadPrev: () => {
      const p = first && neighbours(first).prev;
      if (p && loads[p.id]?.status !== 'error') load(p.id, 'prev');
    },
    /** Retry a chapter that failed (the anchor, or one end of the window). */
    retry: (chapterId: string) => {
      setLoads((l) => {
        const { [chapterId]: _failed, ...rest } = l;
        return rest;
      });
      const where = !segsRef.current.length ? 'anchor' : chapterId === (last && neighbours(last).next?.id) ? 'next' : 'prev';
      load(chapterId, where);
    },
    prune: (currentId: string) => setSegments((cur) => keepAround(cur, currentId)),
  };
}
