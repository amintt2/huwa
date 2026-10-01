// Franchise-aware bridge (pure part of data/mapping-overlay.ts, unit-tested): a season's episodes
// adapt the chapters right after its prequels, community-verified values replace the estimate,
// and a season without its own manhwa link uses the one of an earlier season.
import { makeChapters, type Episode, type MappingInfo, type Series } from './catalog';
import { chainLayout, type MappingOverride, type Range, type SeasonSpec } from './mapping';

/** P2P room of a manhwa's corrections: its AniList id, or the series id (demo, no id). */
export const mappingRoom = (owner: Pick<Series, 'id' | 'manhwaId'>) => (owner.manhwaId ? `m${owner.manhwaId}` : owner.id);

/** Provider ranges that are real data (not an estimate): used as they are. */
const fixedOf = (x: Series): Range[] | undefined =>
  x.manhwa && x.anime && !x.estimated ? x.anime.episodes.map((e) => e.chapters) : undefined;

const cache = new WeakMap<Series, { key: string; manhwa: unknown; out: Series }>();

export function applyMapping(
  s: Series,
  base: (id: string) => Series | undefined,
  prequelIds: string[] | undefined,
  overrideOf: (seasonId: string) => MappingOverride | undefined,
): Series {
  if (!s.anime?.episodes.length) return s;
  const prequels = (prequelIds ?? []).map(base).filter((x): x is Series => !!x?.anime);
  const owner = s.manhwa ? s : [...prequels].reverse().find((x) => x.manhwa);
  if (!owner?.manhwa) return s;
  const manhwa = owner.manhwa;

  const specs: SeasonSpec[] = [...prequels, s].map((x) => ({
    id: x.id,
    episodes: x.anime!.episodes.length,
    fixed: fixedOf(x),
    override: overrideOf(x.id),
  }));
  // A placeholder chapter list (unknown count) never caps the estimate.
  const knownTotal = owner.chaptersKnown === false ? undefined : manhwa.chapters.length;
  const key = JSON.stringify([
    specs.map((sp) => [sp.id, sp.episodes, sp.override ?? null, sp.fixed ? [sp.fixed[0][0], sp.fixed[sp.fixed.length - 1][1]] : 0]),
    knownTotal,
    owner.id,
  ]);
  const hit = cache.get(s);
  if (hit && hit.key === key && hit.manhwa === manhwa) return hit.out;

  const layout = chainLayout(specs, knownTotal);
  const mine = layout[layout.length - 1];
  const prior = layout.slice(0, -1);
  const episodes = s.anime.episodes.map((e, i): Episode => {
    const r = mine.ranges[i];
    const estimated = mine.source === 'source' ? false : !mine.exact[i];
    if (!r) return e;
    return e.chapters[0] === r[0] && e.chapters[1] === r[1] && e.estimated === estimated ? e : { ...e, chapters: [r[0], r[1]] as const, estimated };
  });
  // Unknown chapter count: the placeholder list must reach past the anime.
  const chapters =
    owner.chaptersKnown === false && mine.end + 20 > manhwa.chapters.length ? makeChapters(owner.id, mine.end + 20, false) : manhwa.chapters;
  const mapping: MappingInfo = {
    source: mine.source,
    season: prequels.length,
    after: mine.after,
    end: mine.end,
    afterReliable: prior.every((l) => l.source !== 'estimate'),
    priorEpisodes: prequels.reduce((n, x) => n + x.anime!.episodes.length, 0),
    knownTotal,
    room: mappingRoom(owner),
  };
  const out: Series = {
    ...s,
    anime: { episodes },
    manhwa: chapters === manhwa.chapters ? manhwa : { chapters },
    estimated: mine.source === 'estimate',
    mapping,
  };
  cache.set(s, { key, manhwa, out });
  return out;
}
