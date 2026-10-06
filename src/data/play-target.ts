// Which episode a "Regarder" button should open for a whole franchise (every season of a show).
// Pure (no React Native imports) so it can be unit tested with node:test.
import { resumeEpisode } from './bridge';
import type { Episode, Series } from './catalog';

type Watched = Record<string, { done: boolean; updatedAt: number }>;

export type PlayTarget = {
  episode: Episode;
  /** Season inside the franchise, only when the franchise has several seasons. */
  season?: number;
  /** The user already watched something of this franchise. */
  started: boolean;
  /** Button label, e.g. "Regarder · S1 Ép. 1" or "Reprendre · Ép. 4". */
  label: string;
};

/** Season (several seasons only) and number shown of an episode (data/seasons.ts `episodeNumbering`). */
export type Numbering = (seriesId: string, n: number) => { season?: number; shown: number };

/**
 * `chain` lists the seasons in airing order (first season first). Never watched → episode 1
 * of the first season; otherwise the last episode touched (or the next one when it is finished),
 * moving on to the next season after a season finale. `numbering`: the season model's (parts
 * are one season: AoT Final Season Part 2 ep. 1 = "S4 Ép. 17"); without it, one season per entry.
 */
export function playTarget(chain: Series[], watched: Watched, numbering?: Numbering): PlayTarget | undefined {
  const seasons = chain.filter((s) => s.anime?.episodes.length);
  if (!seasons.length) return undefined;

  let k = -1;
  let latest = -1;
  seasons.forEach((s, i) => {
    for (const e of s.anime!.episodes) {
      const p = watched[e.id];
      if (p && p.updatedAt > latest) {
        latest = p.updatedAt;
        k = i;
      }
    }
  });

  const started = k >= 0;
  let episode: Episode;
  if (!started) {
    k = 0;
    episode = seasons[0].anime!.episodes[0];
  } else {
    const eps = seasons[k].anime!.episodes;
    episode = resumeEpisode(seasons[k], watched) ?? eps[0];
    const finale = episode.id === eps[eps.length - 1].id && watched[episode.id]?.done;
    if (finale && k + 1 < seasons.length) {
      k += 1;
      episode = seasons[k].anime!.episodes[0];
    }
  }
  const num = numbering?.(seasons[k].id, episode.number);
  const season = num ? num.season : seasons.length > 1 ? k + 1 : undefined;
  const label = `${started ? 'Reprendre' : 'Regarder'} · ${season ? `S${season} ` : ''}Ép. ${num?.shown ?? episode.number}`;
  return { episode, season, started, label };
}
