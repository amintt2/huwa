// Where manhwa pages come from. Addons register a `PageSource`; the first one that returns pages
// for a chapter wins, otherwise the demo placeholder pages are used. Offline copies (see
// `downloads.ts`) take priority over all of them — `usePages` handles that.
import { getChapter, pageUrl } from '@/data/catalog';

/** Returns the ordered image URLs of a chapter, or `[]` when this source doesn't have it. */
export type PageSource = (chapterId: string) => Promise<string[]>;

/** A page to render: its URL plus optional request headers (e.g. Referer for some CDNs). */
export type RegisteredSource = { id: string; name: string; fetchPages: PageSource; headers?: Record<string, string> };

const sources: RegisteredSource[] = [];
const listeners = new Set<() => void>();

export function registerPageSource(source: RegisteredSource) {
  const i = sources.findIndex((s) => s.id === source.id);
  if (i >= 0) sources.splice(i, 1, source);
  else sources.push(source);
  listeners.forEach((l) => l());
  return () => {
    const at = sources.indexOf(source);
    if (at >= 0) sources.splice(at, 1);
    listeners.forEach((l) => l());
  };
}

export const hasPageSources = () => sources.length > 0;

export function onPageSourcesChange(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Demo pages, kept as the default until an addon provides real ones. */
export const placeholderPages: PageSource = async (chapterId) => placeholderPagesSync(chapterId);

export function placeholderPagesSync(chapterId: string): string[] {
  const found = getChapter(chapterId);
  return found ? Array.from({ length: found.chapter.pageCount }, (_, i) => pageUrl(chapterId, i)) : [];
}

export type ResolvedPages = { pages: string[]; origin: 'offline' | 'addon' | 'placeholder'; sourceName?: string; headers?: Record<string, string> };

/** Online resolution: registered addons in order, then the placeholder. */
export async function remotePages(chapterId: string): Promise<ResolvedPages> {
  for (const s of [...sources]) {
    try {
      const pages = await s.fetchPages(chapterId);
      if (pages?.length) return { pages, origin: 'addon', sourceName: s.name, headers: s.headers };
    } catch {
      // try the next source
    }
  }
  return { pages: await placeholderPages(chapterId), origin: 'placeholder' };
}
