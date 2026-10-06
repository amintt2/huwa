// Which ids to ask an addon for one episode, best first (pure, unit-tested).
// Formats: `anilist:<id>:<ep>`, `kitsu:<id>:<ep>`, `mal:<id>:<ep>` (per-entry numbering, as
// AniList), and IMDb `tt…:<season>:<episode>` (TheTVDB numbering: split-cour parts continue the
// season, hence `epOffset`), plus a second IMDb guess with TMDB's numbering when it differs.
// Long-runners kept as one AniList entry (One Piece) have no TheTVDB season: their IMDb id comes
// from the season model's verified numbering (data/imdb-episode.ts), resolved when the request
// is made (`LazyId`) so the other id formats never wait for it.
import type { AnimeIds } from './ids';
import { prefixesFor, supports, type Manifest, type Resource } from './protocol';

/**
 * An id known only once asked (IMDb numbering of an absolute entry): `resolve` gives it (null: no
 * IMDb id for this episode), `peek` what is already known without waiting (undefined: not yet).
 */
export type LazyId = { resolve: () => Promise<string | null>; peek: () => string | null | undefined };

/** `id` is a placeholder when `lazy` is set (the job key); the request goes out with the resolved id. */
export type AddonRequest = { type: string; id: string; lazy?: LazyId };

/** One AniList entry numbered absolutely over the whole IMDb show: no TheTVDB season, no offset. */
export const absoluteNumbering = (ids: AnimeIds | null | undefined): boolean =>
  !!ids?.imdb && ids.media !== 'MOVIE' && ids.season == null && ids.epOffset == null && !ids.alt;

/**
 * IMDb video id of an absolute entry's episode: the verified slot (`pair`) when there is one;
 * none when the verified numbering has no slot for it (`null`: One Piece 590); unverified
 * (`undefined`): the guess of `imdbIds` (season 1 of a short show, nothing past episode 26).
 */
export function imdbIdFrom(ids: AnimeIds, episode: number, pair: { season: number; episode: number } | null | undefined): string | null {
  if (pair) return `${ids.imdb}:${pair.season}:${pair.episode}`;
  if (pair === null) return null;
  return imdbIds(ids, episode)[0] ?? null;
}

const anilistOf = (seriesId: string) => {
  const m = /^al(\d+)$/.exec(seriesId);
  return m ? Number(m[1]) : null;
};

/** IMDb video ids for an episode: TheTVDB numbering first, then the alternative one. */
export function imdbIds(ids: AnimeIds | null | undefined, episode: number): string[] {
  if (!ids?.imdb) return [];
  if (ids.media === 'MOVIE') return [ids.imdb];
  // No season known (long-running shows such as One Piece): "S1 E1075" never matches an IMDb
  // listing; only keep the guess for short shows, where season 1 is the likely answer.
  if (ids.season == null && ids.epOffset == null && !ids.alt && episode > 26) return [];
  const main = `${ids.imdb}:${ids.season ?? 1}:${episode + (ids.epOffset ?? 0)}`;
  const out = [main];
  if (ids.alt) {
    const alt = `${ids.imdb}:${ids.alt.season}:${episode + ids.alt.offset}`;
    if (alt !== main) out.push(alt);
  }
  return out;
}

/**
 * Every id format the addon accepts for this episode, in the order to try them.
 * - Addons declaring id prefixes (anime addons, aggregators): anilist, kitsu, mal, then IMDb.
 *   An addon that takes both IMDb and an anime id (AIOStreams, Torrentio, Comet…) gets IMDb in
 *   second position: the two first formats are asked in parallel (see `firstUseful`), and these
 *   aggregators often find videos only for IMDb ids.
 * - Addons without prefixes: IMDb first (the Stremio default), then kitsu, then anilist.
 * The alternative IMDb numbering always comes last (last resort).
 * `lazy`: IMDb id of an absolute entry from the season model (see `absoluteNumbering`), taking
 * the IMDb slot above (asked in the first pair, alongside the first anime id).
 */
export function requestsFor(
  m: Manifest,
  resource: Resource,
  seriesId: string,
  episode: number,
  ids: AnimeIds | null,
  lazy?: LazyId,
): AddonRequest[] {
  const al = anilistOf(seriesId);
  const movie = ids?.media === 'MOVIE';
  const ep = (base: string) => (movie ? base : `${base}:${episode}`);
  const anilistId = al != null ? ep(`anilist:${al}`) : null;
  const kitsu = ids?.kitsu ? ep(`kitsu:${ids.kitsu}`) : null;
  const mal = ids?.mal ? ep(`mal:${ids.mal}`) : null;
  const deferred = !!lazy && !movie && absoluteNumbering(ids);
  // Placeholder: keys the request (job, order); the id sent is the resolved one.
  const [imdb, imdbAlt] = deferred ? [`${ids!.imdb}:abs:${episode}`] : imdbIds(ids, episode);
  const types = movie ? ['movie', 'anime'] : ['series', 'anime'];
  const typeOf = (id: string) => types.find((t) => supports(m, resource, t, id));
  let order: (string | null | undefined)[];
  if (prefixesFor(m, resource).length) {
    const anime = [anilistId, kitsu, mal].filter((x): x is string => !!x && !!typeOf(x));
    order = imdb && typeOf(imdb) && anime.length ? [anime[0], imdb, ...anime.slice(1)] : [...anime, imdb];
  } else order = [imdb, kitsu, anilistId];
  order.push(imdbAlt);
  const out: AddonRequest[] = [];
  for (const id of order) {
    if (!id || out.some((r) => r.id === id)) continue;
    const type = typeOf(id);
    if (type) out.push(deferred && id === imdb ? { type, id, lazy } : { type, id });
  }
  return out;
}
