// Maps imported entries to AniList series:
//  - Stremio ids (`kitsu:`, `mal:`, `anilist:`, `tt…`) through the id mapping (ARM), then AniList;
//    `tt…` ids with no anime mapping are regular films/series and are skipped.
//  - Bare titles (anime-sama, unmapped Kitsu ids) through AniList search.
// The result is shown to the user for review before anything is written.
import { idsForStremioId } from '@/addons/ids';
import { fetchAnimeByIds, matchTitles, type ImportedEntry, type ListStatus } from '@/data/anilist-api';
import type { Series } from '@/data/catalog';

export type Candidate = { source: string; status: ListStatus; stremioId?: string; manhwa?: boolean };
export type Match = { source: string; status: ListStatus; series: Series };
export type Resolution = { matches: Match[]; missed: string[] };

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function resolveCandidates(cands: Candidate[], onProgress?: (done: number, total: number) => void): Promise<Resolution> {
  const total = cands.length;
  let done = 0;
  const tick = () => onProgress?.(++done, total);

  // 1. Stremio ids → AniList ids.
  const withId = cands.filter((c) => c.stremioId);
  const anilistOf = await pool(withId, 4, async (c) => {
    const ids = await idsForStremioId(c.stremioId!).catch(() => null);
    tick();
    return ids?.anilist ?? null;
  });
  const byTitle: Candidate[] = cands.filter((c) => !c.stremioId);
  withId.forEach((c, i) => {
    // Kitsu / MAL ids are anime by definition: fall back to a title search.
    if (anilistOf[i] == null && !/^tt\d/.test(c.stremioId!)) byTitle.push(c);
  });

  const series = await fetchAnimeByIds([...new Set(anilistOf.filter((x): x is number => x != null))]);
  const byId = new Map(series.map((s) => [s.id, s]));
  const matches: Match[] = [];
  const missed: string[] = [];
  withId.forEach((c, i) => {
    const id = anilistOf[i];
    if (id == null) {
      if (/^tt\d/.test(c.stremioId!)) missed.push(c.source);
      return;
    }
    const s = byId.get(`al${id}`);
    if (s) matches.push({ source: c.source, status: c.status, series: s });
    else missed.push(c.source);
  });

  // 2. Titles → AniList search.
  const found = await matchTitles(byTitle.map((c) => ({ title: c.source, manhwa: c.manhwa })));
  byTitle.forEach((c, i) => {
    tick();
    const s = found[i];
    if (s) matches.push({ source: c.source, status: c.status, series: s });
    else missed.push(c.source);
  });

  // One entry per series, keeping the most "active" status.
  const rank: ListStatus[] = ['CURRENT', 'REPEATING', 'COMPLETED', 'PAUSED', 'PLANNING', 'DROPPED'];
  const best = new Map<string, Match>();
  for (const m of matches) {
    const prev = best.get(m.series.id);
    if (!prev || rank.indexOf(m.status) < rank.indexOf(prev.status)) best.set(m.series.id, m);
  }
  return { matches: [...best.values()], missed };
}

export const toEntries = (matches: Match[]): ImportedEntry[] => matches.map((m) => ({ series: m.series, status: m.status }));
