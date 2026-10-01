// Which ids to ask an addon for one episode, best first (pure, unit-tested).
// Formats: `anilist:<id>:<ep>`, `kitsu:<id>:<ep>`, `mal:<id>:<ep>` (per-entry numbering, as
// AniList), and IMDb `tt…:<season>:<episode>` (TheTVDB numbering: split-cour parts continue the
// season, hence `epOffset`), plus a second IMDb guess with TMDB's numbering when it differs.
import type { AnimeIds } from './ids';
import { prefixesFor, supports, type Manifest, type Resource } from './protocol';

export type AddonRequest = { type: string; id: string };

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
 */
export function requestsFor(m: Manifest, resource: Resource, seriesId: string, episode: number, ids: AnimeIds | null): AddonRequest[] {
  const al = anilistOf(seriesId);
  const movie = ids?.media === 'MOVIE';
  const ep = (base: string) => (movie ? base : `${base}:${episode}`);
  const anilistId = al != null ? ep(`anilist:${al}`) : null;
  const kitsu = ids?.kitsu ? ep(`kitsu:${ids.kitsu}`) : null;
  const mal = ids?.mal ? ep(`mal:${ids.mal}`) : null;
  const [imdb, imdbAlt] = imdbIds(ids, episode);
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
    if (type) out.push({ type, id });
  }
  return out;
}
