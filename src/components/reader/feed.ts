// Continuous reading across chapters (pure, no I/O: tested in __tests__).
//
// The reader shows a window of consecutive loaded chapters ("segments") as one flat list:
//   [divider prev|A] A pages… [divider A|B] B pages… [divider B|next]
// A divider sits at every chapter boundary, including both ends of the window: the top one
// introduces the previous (not yet loaded) chapter, the last one the next chapter (or "à jour").
// Divider keys only depend on the two chapters around them, so they stay stable when a chapter
// is added in front: the list keeps its scroll position on the same item.

export type Segment = {
  chapterId: string;
  pages: string[];
  headers?: Record<string, string>;
  origin: 'offline' | 'addon' | 'placeholder';
  sourceName?: string;
};

export type FeedItem =
  | { kind: 'page'; key: string; chapterId: string; seg: number; index: number; count: number; uri: string }
  | { kind: 'divider'; key: string; before?: string; after?: string };

/**
 * `prevOf` / `nextOf`: chapters around the window in catalog order (undefined at the ends).
 * The leading divider is only shown when there is a previous chapter.
 */
export function buildFeed(segments: Segment[], prevOf?: string, nextOf?: string): FeedItem[] {
  const items: FeedItem[] = [];
  const divider = (before?: string, after?: string): FeedItem => ({ kind: 'divider', key: `d:${before ?? ''}|${after ?? ''}`, before, after });
  if (!segments.length) return items;
  if (prevOf) items.push(divider(prevOf, segments[0].chapterId));
  segments.forEach((s, seg) => {
    s.pages.forEach((uri, index) => {
      items.push({ kind: 'page', key: `p:${s.chapterId}:${index}`, chapterId: s.chapterId, seg, index, count: s.pages.length, uri });
    });
    items.push(divider(s.chapterId, segments[seg + 1]?.chapterId ?? nextOf));
  });
  return items;
}

export type Layout = { sizes: number[]; offsets: number[]; total: number };

export function layoutFeed(items: FeedItem[], sizeOf: (item: FeedItem, i: number) => number): Layout {
  const sizes: number[] = [];
  const offsets: number[] = [];
  let acc = 0;
  items.forEach((it, i) => {
    const s = Math.max(0, sizeOf(it, i));
    offsets.push(acc);
    sizes.push(s);
    acc += s;
  });
  return { sizes, offsets, total: acc };
}

/** Index of the last offset <= y (0 when empty). */
export function indexAt(offsets: number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  let at = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= y) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return at;
}

export function indexOfPage(items: FeedItem[], chapterId: string, page: number): number {
  return items.findIndex((it) => it.kind === 'page' && it.chapterId === chapterId && it.index === page);
}

/** Span [start, end) of a chapter's pages along the scroll axis. */
export function chapterSpan(items: FeedItem[], layout: Layout, chapterId: string): { start: number; end: number; first: number; last: number } | undefined {
  let first = -1;
  let last = -1;
  items.forEach((it, i) => {
    if (it.kind === 'page' && it.chapterId === chapterId) {
      if (first < 0) first = i;
      last = i;
    }
  });
  if (first < 0) return undefined;
  return { start: layout.offsets[first], end: layout.offsets[last] + layout.sizes[last], first, last };
}

export type Location = {
  /** Chapter being read (the page under the reading line, or the one a divider ends). */
  chapterId: string;
  page: number;
  /** 0‒1 inside that page. */
  offset: number;
  /** Fraction of the chapter seen (bottom of the viewport against the chapter's span). */
  ratio: number;
  /** Item under the reading line. */
  item: number;
};

/**
 * Where the reader is. The reading line is a third down the viewport, so a chapter becomes
 * current once its first page fills a good part of the screen. `paged`: one item per screen.
 */
export function locate(items: FeedItem[], layout: Layout, y: number, viewport: number, paged = false): Location | undefined {
  if (!items.length) return undefined;
  const line = paged ? y + viewport / 2 : y + viewport / 3;
  let i = indexAt(layout.offsets, Math.max(0, line));
  let it = items[i];
  if (it.kind === 'divider') {
    // On a divider: the chapter it ends (or, at the top, the chapter it starts).
    let j = i - 1;
    while (j >= 0 && items[j].kind !== 'page') j--;
    if (j < 0) {
      j = i + 1;
      while (j < items.length && items[j].kind !== 'page') j++;
    }
    if (j < 0 || j >= items.length) return undefined;
    i = j;
    it = items[j];
  }
  if (it.kind !== 'page') return undefined;
  const span = chapterSpan(items, layout, it.chapterId)!;
  const size = layout.sizes[i] || 1;
  const top = Math.max(0, y);
  const offset = paged ? 0 : Math.min(1, Math.max(0, (top - layout.offsets[i]) / size));
  const ratio = paged
    ? (it.index + 1) / it.count
    : Math.min(1, Math.max(0, (top + viewport - span.start) / Math.max(1, span.end - span.start)));
  return { chapterId: it.chapterId, page: it.index, offset, ratio, item: i };
}

/** Segments to keep around the current one: at most one before and one after. */
export function keepAround<T extends { chapterId: string }>(segments: T[], currentId: string, radius = 1): T[] {
  const at = segments.findIndex((s) => s.chapterId === currentId);
  if (at < 0) return segments;
  const from = Math.max(0, at - radius);
  const to = Math.min(segments.length, at + radius + 1);
  return from === 0 && to === segments.length ? segments : segments.slice(from, to);
}
