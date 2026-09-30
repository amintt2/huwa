import { Image } from 'expo-image';
import { useEffect, useState } from 'react';

import { offlinePages } from './downloads';
import { hasPageSources, onPageSourcesChange, placeholderPagesSync, remotePages, type ResolvedPages } from './pageSource';

type State = ResolvedPages & { chapterId: string; loading: boolean };

function immediate(chapterId: string): State | undefined {
  const local = offlinePages(chapterId);
  if (local) return { chapterId, pages: local, origin: 'offline', loading: false };
  if (!hasPageSources()) return { chapterId, pages: placeholderPagesSync(chapterId), origin: 'placeholder', loading: false };
  return undefined;
}

/** Pages of a chapter: offline copy → addon page sources → placeholder. */
export function usePages(chapterId: string): State {
  const [state, setState] = useState<State>(
    () => immediate(chapterId) ?? { chapterId, pages: [], origin: 'placeholder', loading: true },
  );
  const [gen, setGen] = useState(0);
  useEffect(() => onPageSourcesChange(() => setGen((g) => g + 1)), []);

  useEffect(() => {
    let alive = true;
    const now = immediate(chapterId);
    if (now) {
      if (gen > 0) Promise.resolve().then(() => alive && setState(now));
      return;
    }
    remotePages(chapterId).then((r) => alive && setState({ ...r, chapterId, loading: false }));
    return () => {
      alive = false;
    };
  }, [chapterId, gen]);

  return state.chapterId === chapterId ? state : { chapterId, pages: [], origin: 'placeholder', loading: true };
}

/** Warm the image cache for upcoming pages (and the next chapter's first pages). */
export function prefetchPages(urls: string[], headers?: Record<string, string>) {
  const remote = urls.filter((u) => /^https?:/i.test(u));
  if (remote.length) Image.prefetch(remote, { cachePolicy: 'memory-disk', headers }).catch(() => {});
}

export async function prefetchChapterStart(chapterId: string, count = 3) {
  const local = offlinePages(chapterId);
  if (local) return;
  const { pages, headers } = await remotePages(chapterId);
  prefetchPages(pages.slice(0, count), headers);
}
