// Franchise relations between AniList entries, and the walk along them. No runtime import beyond
// this file, so the chain building is unit-tested under Node (src/data/__tests__/franchise-chain).
import type { Media } from './anilist';

const TV_FORMATS = ['TV', 'TV_SHORT', 'ONA'];
export const isTvLike = (m: Pick<Media, 'format'>) => !m.format || TV_FORMATS.includes(m.format);

function related(m: Media, type: 'PREQUEL' | 'SEQUEL'): Media | undefined {
  const edges = (m.relations?.edges ?? []).filter((e) => e.relationType === type && e.node.type === 'ANIME');
  // A TV season over a movie or a special when both exist.
  return (edges.find((e) => isTvLike(e.node)) ?? edges[0])?.node;
}

/** Previous entry of an anime franchise (a TV season over a movie or a special when both exist). */
export const prequelOf = (m: Media) => related(m, 'PREQUEL');
/** Next entry of an anime franchise (a TV season over a movie or a special when both exist). */
export const sequelOf = (m: Media) => related(m, 'SEQUEL');

/** Hops followed in each direction: enough for long franchises, bounded for broken data. */
export const MAX_HOPS = 8;

export type FetchMedia = (id: number) => Promise<Media>;

/** A season of the franchise: TV-like anime (movies and specials are walked through, not listed). */
export const isSeasonEntry = (m: Media) => m.type === 'ANIME' && isTvLike(m);

/**
 * Follows one relation from `first` (nearest first), at most `maxHops` fetches. `seen` holds the
 * ids already visited (cycles stop the walk) and is updated. Rejects when a fetch fails.
 */
export async function walkRelation(
  first: number | null | undefined,
  step: (m: Media) => Media | undefined,
  fetch: FetchMedia,
  seen: Set<number>,
  maxHops = MAX_HOPS,
): Promise<Media[]> {
  const out: Media[] = [];
  let next = first ?? null;
  for (let hop = 0; hop < maxHops && next != null && !seen.has(next); hop++) {
    seen.add(next);
    const m = await fetch(next);
    if (isSeasonEntry(m)) out.push(m);
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
    const before = prequels ? (await walkRelation(prequelOf(self)?.id, prequelOf, fetch, seen, maxHops)).reverse() : [];
    const after = await walkRelation(sequelOf(self)?.id, sequelOf, fetch, seen, maxHops);
    return { before, self, after, ok: true };
  } catch {
    return { before: [], self: null, after: [], ok: false };
  }
}
