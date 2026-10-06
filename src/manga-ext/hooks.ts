import { useEffect, useState } from 'react';

import { searchSource, sourceImageHeaders } from './api';
import { isCloudflareError, sourceErrorText } from './cloudflare-core';
import { useMangaExt, type InstalledSource } from './registry';
import type { ExtSearchItem } from './validate';

export type SourceResults = {
  source: InstalledSource;
  state: 'loading' | 'ok' | 'error';
  items: ExtSearchItem[];
  error?: string;
  /** The site asks for a Cloudflare check (page to open, when known). */
  blocked?: { url?: string };
  imageHeaders?: Record<string, string>;
  /** Searches again (after a Cloudflare check). */
  retry: () => void;
};

/** Searches every enabled source in parallel (debounced); results appear as each source answers. */
export function useSourceSearch(query: string, enabled = true, delay = 500): SourceResults[] {
  const { installed, showAdult } = useMangaExt();
  const sources = installed.filter((s) => s.enabled && (showAdult || s.contentRating !== 'ADULT'));
  const q = query.trim();
  const key = `${q}|${sources.map((s) => `${s.key}@${s.version}`).join(',')}`;
  const [res, setRes] = useState<{ key: string; rows: Record<string, Omit<SourceResults, 'source' | 'retry'>> }>({ key: '', rows: {} });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || q.length < 2 || !sources.length) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      for (const s of sources) {
        searchSource(s.key, q)
          .then(async (page) => {
            const sample = page.items.find((i) => i.image)?.image;
            return { state: 'ok' as const, items: page.items.slice(0, 20), imageHeaders: sample ? await sourceImageHeaders(s.key, sample) : undefined };
          })
          .catch((e: unknown) => ({ state: 'error' as const, items: [], error: sourceErrorText(e), blocked: isCloudflareError(e) ? { url: e.url } : undefined }))
          .then((row) => {
            if (!cancelled) setRes((p) => ({ key, rows: { ...(p.key === key ? p.rows : {}), [s.key]: row } }));
          });
      }
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, attempt]);

  if (!enabled || q.length < 2) return [];
  return sources.map((source) => {
    const r = res.key === key ? res.rows[source.key] : undefined;
    return { source, state: r?.state ?? 'loading', items: r?.items ?? [], error: r?.error, blocked: r?.blocked, imageHeaders: r?.imageHeaders, retry: () => setAttempt((n) => n + 1) };
  });
}
