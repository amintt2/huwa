// Franchise relations between AniList entries, and the walk along them. No runtime import beyond
// this file, so the chain building is unit-tested under Node (src/data/__tests__/franchise-chain).
import type { Media } from './anilist';

const TV_FORMATS = ['TV', 'TV_SHORT', 'ONA'];
export const isTvLike = (m: Pick<Media, 'format'>) => !m.format || TV_FORMATS.includes(m.format);

/** Below this, a TV_SHORT / ONA entry is a one-shot (e.g. One Piece's 1-episode "MONSTERS" ONA). */
export const MIN_SEASON_EPISODES = 4;

/**
 * A season of the franchise: a TV entry (format unknown counts as TV), or a TV_SHORT / ONA with
 * at least 4 episodes (or no count yet while it airs or is announced). One-shots, recaps, movies
 * and specials are walked through, not listed (they go to the "Spéciaux" entry of the picker).
 */
export function isSeasonEntry(m: Pick<Media, 'type' | 'format' | 'episodes' | 'status'>): boolean {
  if (m.type !== 'ANIME' || !isTvLike(m)) return false;
  if (!m.format || m.format === 'TV') return true;
  if (m.episodes != null) return m.episodes >= MIN_SEASON_EPISODES;
  return m.status === 'RELEASING' || m.status === 'NOT_YET_RELEASED';
}

function related(m: Media, type: 'PREQUEL' | 'SEQUEL'): Media | undefined {
  const edges = (m.relations?.edges ?? []).filter((e) => e.relationType === type && e.node.type === 'ANIME');
  // A season over a movie, a special or a one-shot when several exist.
  return (edges.find((e) => isSeasonEntry(e.node)) ?? edges.find((e) => isTvLike(e.node)) ?? edges[0])?.node;
}

/** Previous entry of an anime franchise (a season over a movie or a special when both exist). */
export const prequelOf = (m: Media) => related(m, 'PREQUEL');
/** Next entry of an anime franchise (a season over a movie or a special when both exist). */
export const sequelOf = (m: Media) => related(m, 'SEQUEL');

/** Hops followed in each direction: enough for long franchises, bounded for broken data. */
export const MAX_HOPS = 8;

export type FetchMedia = (id: number) => Promise<Media>;

/**
 * Follows one relation from `first` (nearest first), at most `maxHops` fetches. `seen` holds the
 * ids already visited (cycles stop the walk) and is updated. Entries that are not seasons are
 * pushed to `skipped` when given. Rejects when a fetch fails.
 */
export async function walkRelation(
  first: number | null | undefined,
  step: (m: Media) => Media | undefined,
  fetch: FetchMedia,
  seen: Set<number>,
  maxHops = MAX_HOPS,
  skipped?: Media[],
): Promise<Media[]> {
  const out: Media[] = [];
  let next = first ?? null;
  for (let hop = 0; hop < maxHops && next != null && !seen.has(next); hop++) {
    seen.add(next);
    const m = await fetch(next);
    if (isSeasonEntry(m)) out.push(m);
    else if (m.type === 'ANIME') skipped?.push(m);
    next = step(m)?.id ?? null;
  }
  return out;
}

export type FranchiseChain = {
  /** Earlier seasons, first season first (empty when not walked). */
  before: Media[];
  /** The series itself, null when the resolution failed. */
  self: Media | null;
  /** Later seasons, in airing order. */
  after: Media[];
  /** Entries walked through on the way (movies, specials, one-shots), for the specials list. */
  skipped: Media[];
  ok: boolean;
};

/**
 * Whole franchise around an AniList anime: prequels + itself + sequels. `prequels: false` skips
 * the backward walk (already known). Never rejects: a failure gives `ok: false` with no season.
 */
export async function franchiseChain(
  selfId: number,
  fetch: FetchMedia,
  { maxHops = MAX_HOPS, prequels = true }: { maxHops?: number; prequels?: boolean } = {},
): Promise<FranchiseChain> {
  try {
    const self = await fetch(selfId);
    const seen = new Set([selfId]);
    const skipped: Media[] = [];
    const before = prequels ? (await walkRelation(prequelOf(self)?.id, prequelOf, fetch, seen, maxHops, skipped)).reverse() : [];
    const after = await walkRelation(sequelOf(self)?.id, sequelOf, fetch, seen, maxHops, skipped);
    return { before, self, after, skipped, ok: true };
  } catch {
    return { before: [], self: null, after: [], skipped: [], ok: false };
  }
}

// ---------- specials (last entry of the season picker) ----------

/**
 * Relations listed under "Spéciaux": side stories (OVAs, specials, movies), recaps, and the
 * prequels / sequels that are not seasons. Spin-offs, alternative versions, character crossovers
 * and "other" links are left out (not the same continuity, or not the show at all).
 */
/** Something to watch in the specials list (aired, not a music video). */
export const isListedSpecial = (n: Pick<Media, 'type' | 'format' | 'status'>) =>
  n.type === 'ANIME' && n.format !== 'MUSIC' && n.status !== 'NOT_YET_RELEASED' && n.status !== 'CANCELLED';

export function specialRelationsOf(m: Media): Media[] {
  return (m.relations?.edges ?? [])
    .filter((e) => {
      const n = e.node;
      if (!isListedSpecial(n)) return false;
      if (e.relationType === 'SIDE_STORY' || e.relationType === 'SUMMARY') return true;
      // Seasons are in the picker already.
      return (e.relationType === 'PREQUEL' || e.relationType === 'SEQUEL') && !isSeasonEntry(n);
    })
    .map((e) => e.node);
}
