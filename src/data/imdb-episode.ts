// IMDb id of one episode for addon requests (`tt0388629:21:109`), from the season model's
// verified numbering. Long-runners kept as one AniList entry (One Piece, Detective Conan) have no
// TheTVDB season in ARM / Fribb, and "S1 E1000" matches nothing on Torrentio or Cinemeta.
// Works from the stream request path alone: the Cinemeta listing and the anime-kitsu table come
// from their disk caches (./cinemeta.ts), fetched on demand otherwise, waiting at most a few
// seconds (the other id formats are asked meanwhile, see addons/id-candidates.ts `LazyId`).
// What only the anime page can tell (the whole franchise rejects the numbering) wins
// (`rememberRejected`).
import { absoluteNumbering, imdbIdFrom, type LazyId } from '@/addons/id-candidates';
import type { AnimeIds } from '@/addons/ids';

import { getSeries } from './catalog';
import { kitsuPairs, showEpisodes } from './cinemeta';
import { jstDate, pairOf, verifiedRuns, type Run, type SeasonEntry } from './seasons';

/** Longest wait for the numbering before the IMDb request goes out without it. */
export const RESOLVE_TIMEOUT_MS = 6000;

/** Series id → numbering rejected by the anime page for the whole franchise. */
const rejected = new Map<string, { imdb: string; count: number }>();
/** `${seriesId}:${imdb}:${count}` → numbering verified here (kept for the session). */
const settled = new Map<string, Run[]>();
const jobs = new Map<string, Promise<Run[] | null>>();

/**
 * The anime page refused an absolute entry's numbering for reasons only the franchise shows (an
 * IMDb id shared by several seasons, two entries on the same episodes): no verified IMDb id.
 */
export function rememberRejected(seriesId: string, imdb: string, count: number) {
  rejected.set(seriesId, { imdb, count });
}

async function verify(entry: SeasonEntry, imdb: string, kitsu: number | undefined): Promise<Run[] | null> {
  const today = jstDate(new Date().toISOString())!;
  // Both at once (disk caches after the first time): the anime-kitsu table goes first when it
  // lines up with Cinemeta (see `verifiedRuns`).
  const [show, pairs] = await Promise.all([showEpisodes(imdb).catch(() => null), kitsu ? kitsuPairs(kitsu).catch(() => null) : null]);
  return verifiedRuns(entry, show, pairs, today).runs ?? null;
}

type Slot = { season: number; episode: number } | null | undefined;

/** What is known now: a slot, null (verified, no slot), undefined (not verified / not known yet). */
function known(seriesId: string, episode: number, ids: AnimeIds, count: number): { done: boolean; slot: Slot } {
  const no = rejected.get(seriesId);
  if (no && no.imdb === ids.imdb && no.count === count) return { done: true, slot: undefined };
  const runs = settled.get(`${seriesId}:${ids.imdb}:${count}`);
  if (runs === undefined) return { done: false, slot: undefined };
  return { done: true, slot: pairOf(runs, episode) ?? null };
}

/**
 * Verified IMDb slot of an episode of an absolute entry: a pair, null when the verified numbering
 * has none (One Piece 590), undefined when unverified (or not known within `timeoutMs`).
 */
export async function verifiedSlot(seriesId: string, episode: number, ids: AnimeIds, timeoutMs = RESOLVE_TIMEOUT_MS): Promise<Slot> {
  const series = getSeries(seriesId);
  const count = series?.anime?.episodes.length ?? 0;
  if (!series || !count || !absoluteNumbering(ids)) return undefined;
  const now = known(seriesId, episode, ids, count);
  if (now.done) return now.slot;
  const imdb = ids.imdb!;
  const k = `${seriesId}:${imdb}:${count}`;
  let job = jobs.get(k);
  if (!job) {
    const entry: SeasonEntry = {
      id: seriesId,
      title: series.title,
      episodes: count,
      start: series.start,
      year: series.year || undefined,
      ongoing: series.status === 'ongoing',
      map: { imdb },
    };
    job = verify(entry, imdb, ids.kitsu)
      .catch(() => null)
      .then((runs) => {
        // Not verified (offline, listing behind): asked again next time (Cinemeta's own cache
        // keeps that cheap); verified: kept for the session.
        if (runs) settled.set(k, runs);
        jobs.delete(k);
        return runs;
      });
    jobs.set(k, job);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const runs = await Promise.race([job, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), timeoutMs)))]);
  clearTimeout(timer);
  return runs ? (pairOf(runs, episode) ?? null) : undefined;
}

/** The IMDb candidate of an absolute entry's episode, resolved when an addon is asked. */
export function lazyImdbId(seriesId: string, episode: number, ids: AnimeIds): LazyId {
  return {
    resolve: async () => imdbIdFrom(ids, episode, await verifiedSlot(seriesId, episode, ids)),
    peek: () => {
      const count = getSeries(seriesId)?.anime?.episodes.length ?? 0;
      const now = known(seriesId, episode, ids, count);
      return now.done ? imdbIdFrom(ids, episode, now.slot) : undefined;
    },
  };
}
