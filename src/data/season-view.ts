// What the anime page shows for seasons: the picker rows (grouped parts, TheTVDB sub-seasons of
// long entries, "Spéciaux"), the episode rows of the selected season with their real titles,
// and the "S21 · Ép. 1000" badges. Pure model in ./seasons.ts; this file loads its inputs
// (IMDb numbering per entry, Cinemeta listings, anime-kitsu pairs), all cached on disk.
import { useEffect, useMemo, useState } from 'react';

import { idsForAnilist, type AnimeIds } from '@/addons/ids';
import { useStore } from '@/store/store';

import { resumeEpisode } from './bridge';
import { getSeries, useCatalog, type Episode, type Series } from './catalog';
import { kitsuPairs, showEpisodes, type KitsuPair } from './cinemeta';
import { rememberRejected } from './imdb-episode';
import {
  chronologyLabel,
  chronologyName,
  composeSeasons,
  episodeBadge,
  indexShow,
  infoOf,
  jstDate,
  seasonOf,
  shownNumber,
  upcomingPair,
  type DisplaySeason,
  type SeasonEntry,
  type ShowEpisode,
  type SpecialItem,
} from './seasons';

export type FranchiseInput = { seasons: Series[]; specials: SpecialItem[] };

export type EpisodeRow = {
  episode: Episode;
  /** Series of this episode (a season grouped from several AniList entries mixes them). */
  series: Series;
  /** Number shown: absolute for long-runners, continuing across parts otherwise. */
  number: number;
  /** Real title (Cinemeta, verified numbering). */
  title?: string;
  /** "S21 · É109 · 21 nov. 2021", "Partie 2 · ép. 1 · 9 janv. 2022". */
  meta?: string;
};

export type SpecialRow = SpecialItem & { kind: string; when?: string };

export type SeasonView = {
  /** Picker rows, in order (the specials entry comes after them, when there are specials). */
  seasons: DisplaySeason[];
  specials: SpecialRow[];
  /** Selected season, undefined when the specials list is shown. */
  selected?: DisplaySeason;
  showSpecials: boolean;
  rows: EpisodeRow[];
  /** "S21 · Ép. 1000" / "S4 · Ép. 17" / "Ép. 3". */
  badge: (e: Episode) => string;
  /**
   * An episode of this series still to air (AniList number), shown like the aired rows: number
   * continuing across parts, "S23 · É26" (absolute seasons) or "Partie 2 · ép. 5".
   */
  upcoming: (n: number, airingAt: number) => { number: number; where?: string };
  /** Label of the button next to the "Épisodes" tab. */
  buttonLabel: string;
  /** "Saison 4" chip of the meta line (undefined: a lone season). */
  chipLabel?: string;
  /** The selected season is the last one (episodes still to air belong to it). */
  last: boolean;
  /** Something to pick: several seasons, or specials. */
  pickable: boolean;
};

export const SPECIALS_KEY = 'specials';

// ---------- loaded inputs (module caches shared by every page) ----------

const idsMemo = new Map<string, AnimeIds | null>();
const showsMemo = new Map<string, ShowEpisode[] | null>();
const pairsMemo = new Map<number, KitsuPair[] | null>();
const pending = new Set<string>();

const anilistOf = (id: string) => (/^al\d+$/.test(id) ? Number(id.slice(2)) : null);

function load<T>(tag: string, memo: Map<T, unknown>, k: T, job: () => Promise<unknown>, done: () => void) {
  if (memo.has(k) || pending.has(tag)) return;
  pending.add(tag);
  job()
    .catch(() => null)
    .then((v) => {
      memo.set(k, v ?? null);
      pending.delete(tag);
      done();
    });
}

const mapOf = (ids: AnimeIds | null | undefined) =>
  ids === undefined ? undefined : ids?.imdb && ids.media !== 'MOVIE' ? { imdb: ids.imdb, season: ids.season, offset: ids.epOffset } : null;

// ---------- dates ----------

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
/** "2021-11-21" → "21 nov. 2021" */
export const dayLabel = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
/** "2021-11-21" → "nov. 2021" */
export const monthLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

const KIND: Record<string, string> = { MOVIE: 'Film', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'Spécial', TV_SHORT: 'Court', TV: 'Récap' };

// ---------- the hook ----------

/**
 * Season model of an anime page. `franchise` is `useFranchiseSeasons` (undefined while loading:
 * the series alone), `pick` the season chosen in the picker (a key of `seasons`, or
 * SPECIALS_KEY). Works offline from the disk caches, AniList-only when nothing is known.
 */
export function useSeasonView(series: Series | undefined, franchise: FranchiseInput | undefined, pick: string | undefined): SeasonView | undefined {
  const catalogVersion = useCatalog();
  const progress = useStore((s) => s.episodes);
  const [loaded, setLoaded] = useState(0);
  const bump = () => setLoaded((n) => n + 1);

  const list = useMemo(() => (franchise?.seasons.length ? franchise.seasons : series ? [series] : []), [franchise, series]);
  const listKey = list.map((s) => `${s.id}:${s.anime?.episodes.length ?? 0}`).join(',');

  // IMDb numbering of every season (ARM + Fribb, cached 30 days).
  useEffect(() => {
    for (const s of list) {
      const al = anilistOf(s.id);
      if (al != null) load(`ids:${s.id}`, idsMemo, s.id, () => idsForAnilist(al), bump);
    }
  }, [listKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const entries: SeasonEntry[] = useMemo(
    () =>
      list.map((s) => ({
        id: s.id,
        title: s.title,
        episodes: s.anime?.episodes.length ?? 0,
        start: s.start,
        year: s.year || undefined,
        ongoing: s.status === 'ongoing',
        map: anilistOf(s.id) == null ? null : mapOf(idsMemo.get(s.id)),
      })),
    [listKey, loaded, catalogVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const imdbs = [...new Set(entries.map((e) => e.map?.imdb).filter((x): x is string => !!x))];

  // Cinemeta listings of the shows involved (usually one).
  useEffect(() => {
    for (const imdb of imdbs) load(`show:${imdb}`, showsMemo, imdb, () => showEpisodes(imdb), bump);
  }, [imdbs.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentId = series?.id ?? '';
  const kitsu = idsMemo.get(currentId)?.kitsu;
  const composed = useMemo(() => {
    const shows = Object.fromEntries(imdbs.map((i) => [i, showsMemo.get(i)]));
    const today = jstDate(new Date().toISOString())!;
    return composeSeasons({ entries, currentId, shows, pairs: kitsu ? pairsMemo.get(kitsu) : undefined, today });
  }, [entries, currentId, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Absolute numbering off by an episode somewhere: the anime-kitsu table may line it up.
  useEffect(() => {
    if (composed.wantPairs && kitsu) load(`pairs:${kitsu}`, pairsMemo, kitsu, () => kitsuPairs(kitsu), bump);
  }, [composed.wantPairs, kitsu]);

  // Absolute entries whose numbering the franchise rejects: no IMDb id for their addon
  // requests (data/imdb-episode.ts verifies the others on its own, from the same caches).
  useEffect(() => {
    for (const e of entries) {
      const imdb = e.map?.imdb;
      const why = composed.rejected[e.id];
      if (imdb && e.map?.season == null && e.map?.offset == null && (why === 'shared' || why === 'overlap')) rememberRejected(e.id, imdb, e.episodes);
    }
  }, [composed, entries]);

  return useMemo(() => {
    if (!series?.anime) return undefined;
    const { seasons, mappings } = composed;
    const seriesOf = (id: string) => (id === series.id ? series : getSeries(id));
    const indexes = new Map<string, Map<number, ShowEpisode>>();
    const infoFor = (seriesId: string, n: number) => {
      const m = mappings[seriesId];
      const imdb = entries.find((e) => e.id === seriesId)?.map?.imdb;
      const show = imdb ? showsMemo.get(imdb) : undefined;
      if (!m || !imdb || !show) return undefined;
      let idx = indexes.get(imdb);
      if (!idx) indexes.set(imdb, (idx = indexShow(show)));
      return infoOf(m.runs, idx, n);
    };

    const resume = resumeEpisode(series, progress) ?? series.anime.episodes[0];
    const specialsList = franchise?.specials ?? [];
    const showSpecials = pick === SPECIALS_KEY && specialsList.length > 0;
    const selected = showSpecials
      ? undefined
      : (seasons.find((s) => s.key === pick && s.parts.some((p) => p.seriesId === series.id)) ??
        seasonOf(seasons, series.id, resume?.number ?? 1));

    const rows: EpisodeRow[] = [];
    for (const part of selected?.parts ?? []) {
      const s = seriesOf(part.seriesId);
      for (const e of s?.anime?.episodes.slice(part.from - 1, part.to) ?? []) {
        const info = infoFor(part.seriesId, e.number);
        const where = selected?.absolute
          ? info && `S${info.season} · É${info.episode}`
          : part.label && `${part.label} · ép. ${e.number}`;
        rows.push({
          episode: e,
          series: s!,
          number: shownNumber(selected, part.seriesId, e.number),
          title: info?.title,
          meta: [where, info?.date && dayLabel(info.date)].filter(Boolean).join(' · ') || undefined,
        });
      }
    }
    // Rows of a season without any (selection of an evicted series): the page's own episodes.
    if (!rows.length && !showSpecials) {
      for (const e of series.anime.episodes) rows.push({ episode: e, series, number: e.number });
    }

    // Chronology of the specials: every dated episode of the verified seasons, oldest first.
    const dated: { date?: string; label: string }[] = [];
    if (showSpecials || specialsList.length) {
      for (const s of seasons) {
        for (const p of s.parts) {
          if (!mappings[p.seriesId]) continue;
          for (let n = p.from; n <= p.to; n++) {
            const date = infoFor(p.seriesId, n)?.date;
            if (date) dated.push({ date, label: chronologyName(s, p.shownFrom + n - p.from) });
          }
        }
      }
      dated.sort((a, b) => a.date!.localeCompare(b.date!));
    }
    const open = list.some((s) => s.status === 'ongoing');
    const specials: SpecialRow[] = specialsList.map((x) => ({
      ...x,
      kind: KIND[x.format ?? ''] ?? 'Spécial',
      when: chronologyLabel(x.start, dated, open),
    }));

    const multi = seasons.length > 1;
    const count = series.anime.episodes.length;
    // Episodes still to air continue the part holding this series' latest episode.
    const lastSeason = seasonOf(seasons, series.id, Math.max(1, count));
    const lastPart = lastSeason?.parts.filter((p) => p.seriesId === series.id).sort((a, b) => b.to - a.to)[0];
    const upcoming = (n: number, airingAt: number) => {
      if (!lastSeason || !lastPart) return { number: n };
      let where: string | undefined;
      if (lastSeason.absolute) {
        const m = mappings[series.id];
        const imdb = entries.find((e) => e.id === series.id)?.map?.imdb;
        const show = imdb ? showsMemo.get(imdb) : undefined;
        const p = m && show ? upcomingPair(m.runs, show, n, jstDate(new Date(airingAt * 1000).toISOString())) : undefined;
        where = p && `S${p.season} · É${p.episode}`;
      } else if (lastPart.label) {
        where = `${lastPart.label} · ép. ${n}`;
      }
      return { number: lastPart.shownFrom + n - lastPart.from, where };
    };
    return {
      seasons,
      specials,
      selected,
      showSpecials,
      rows,
      badge: (e: Episode) => episodeBadge(seasonOf(seasons, e.seriesId, e.number), e.seriesId, e.number, seasons.length),
      upcoming,
      chipLabel: multi ? (selected?.absolute ? selected : seasonOf(seasons, series.id, 1))?.label : undefined,
      buttonLabel: showSpecials ? (specials.some((x) => x.format === 'MOVIE') ? 'Films & spéciaux' : 'Spéciaux') : (selected?.label ?? 'Saison 1'),
      // Episodes still to air follow this series' latest one.
      last: !showSpecials && (!selected || selected.parts.some((p) => p.seriesId === series.id && p.to >= count)),
      pickable: multi || specials.length > 0,
    };
  }, [series, composed, franchise, pick, progress, entries, list]);
}
