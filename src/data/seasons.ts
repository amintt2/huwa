// Seasons as people know them, built from AniList entries + TheTVDB numbering (Cinemeta).
// Pure (no React Native import): unit-tested under Node (src/data/__tests__/seasons.test.ts).
//
// · AniList splits one season into several entries ("Final Season Part 2", "Cour 2"): those are
//   grouped into one season of the picker, numbered like TheTVDB / Cinemeta when known (AoT's
//   Final Season parts = "Saison 4"). Each part keeps its own AniList id (episode ids, addons).
//   Signals, most reliable first: same IMDb id + same TheTVDB season (Fribb / ARM), then a
//   "Part 2" / "Cour 2" title on the same base title. Air dates alone never group: AoT's two
//   Final Season parts are 10 months apart, Demon Slayer's Mugen Train and Entertainment
//   District arcs 1 week apart yet two TheTVDB seasons.
// · AniList keeps long-runners (One Piece, Detective Conan) as one entry: their TheTVDB seasons
//   become sub-seasons of that entry (a range of its absolute episodes).
// · Episode titles / air dates come from Cinemeta, only where the numbering is verified (first
//   air date, episode counts). Wrong titles are worse than none.

/** An entry is "long" past this many episodes: its TheTVDB seasons become sub-seasons. */
export const LONG_ENTRY = 60;
/** Air dates of AniList and TheTVDB may differ by a day or two (time zones, late-night slots). */
export const DATE_SLACK_DAYS = 2;

// ---------- inputs ----------

/** TheTVDB / IMDb numbering of an AniList entry (ARM + Fribb anime-lists, see addons/ids.ts). */
export type EntryMap = {
  imdb?: string;
  /** TheTVDB season; undefined = absolute numbering over the whole show (One Piece). */
  season?: number;
  /** Added to the AniList episode number inside `season` (split-cour parts). */
  offset?: number;
};

export type SeasonEntry = {
  /** Catalog id (`al<id>`). */
  id: string;
  title: string;
  /** Episodes listed in the app (aired ones). */
  episodes: number;
  /** First air date (YYYY-MM-DD) when AniList knows the day. */
  start?: string;
  year?: number;
  ongoing?: boolean;
  /** undefined: not resolved yet; null: no IMDb mapping. */
  map?: EntryMap | null;
};

/** One Cinemeta video, compacted: season, episode, title, air date (YYYY-MM-DD, Japan time). */
export type ShowEpisode = { s: number; e: number; title?: string; date?: string };

/** Absolute ↔ TheTVDB numbering: AniList episodes from..from+count-1 ↔ season, episode.. */
export type Run = { from: number; count: number; season: number; episode: number };

export type EpisodeInfo = { season: number; episode: number; title?: string; date?: string };

// ---------- dates ----------

const DAY = 86400e3;

/** "2020-12-06T15:30:00.000Z" → "2020-12-07" (Japan time, where anime air). */
export function jstDate(iso: string | undefined | null): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
}

export const daysBetween = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;

/** AniList fuzzy date → YYYY-MM-DD, only when the day is known. */
export function fuzzyDate(d: { year: number | null; month: number | null; day: number | null } | null | undefined) {
  if (!d?.year || !d.month || !d.day) return undefined;
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

// ---------- Cinemeta show ----------

const PLACEHOLDER = /^(episode|épisode|ep\.?)\s*\d+$/i;

/** Raw Cinemeta videos → compact episodes (titles that only repeat the number are dropped). */
export function compactVideos(
  videos: { season?: number; episode?: number; name?: string; title?: string; released?: string; firstAired?: string }[],
): ShowEpisode[] {
  const out: ShowEpisode[] = [];
  for (const v of videos) {
    if (typeof v.season !== 'number' || typeof v.episode !== 'number' || v.season < 0 || v.episode < 0) continue;
    const name = (v.name ?? v.title ?? '').trim();
    out.push({ s: v.season, e: v.episode, title: name && !PLACEHOLDER.test(name) ? name : undefined, date: jstDate(v.released ?? v.firstAired) });
  }
  return out.sort((a, b) => a.s - b.s || a.e - b.e);
}

const key = (s: number, e: number) => s * 100000 + e;
export const indexShow = (show: ShowEpisode[]) => new Map(show.map((x) => [key(x.s, x.e), x]));

/** Regular episodes (season ≥ 1) aired by `today` (undated ones are not aired yet), in order. */
export const airedRegular = (show: ShowEpisode[], today: string) =>
  show.filter((x) => x.s > 0 && !!x.date && x.date <= today);

// ---------- runs ----------

/** An entry inside one TheTVDB season: one run. */
export const seasonRuns = (count: number, season: number, offset = 0): Run[] =>
  count > 0 ? [{ from: 1, count, season, episode: offset + 1 }] : [];

/** Absolute numbering over the regular seasons, in order (no gap allowed in between). */
export function cumulativeRuns(show: ShowEpisode[], count: number): Run[] {
  const runs: Run[] = [];
  let n = 1;
  for (const x of show) {
    if (x.s <= 0 || n > count) continue;
    const last = runs[runs.length - 1];
    if (last && last.season === x.s && last.episode + last.count === x.e) last.count++;
    else runs.push({ from: n, count: 1, season: x.s, episode: x.e });
    n++;
  }
  return runs;
}

/**
 * Absolute ↔ IMDb numbering from Stremio's anime-kitsu addon (`imdbSeason` / `imdbEpisode` per
 * absolute episode, the table Torrentio relies on): exact where TheTVDB moved an episode to the
 * specials (One Piece 590). Episodes without a pair are left out.
 */
export function runsFromPairs(pairs: { n: number; season?: number | null; episode?: number | null }[], count: number): Run[] {
  const runs: Run[] = [];
  for (const p of [...pairs].sort((a, b) => a.n - b.n)) {
    if (p.n < 1 || p.n > count || !p.season || p.season < 1 || !p.episode) continue;
    const last = runs[runs.length - 1];
    if (last && last.season === p.season && last.from + last.count === p.n && last.episode + last.count === p.episode) last.count++;
    else runs.push({ from: p.n, count: 1, season: p.season, episode: p.episode });
  }
  return runs;
}

export function pairOf(runs: Run[], n: number): { season: number; episode: number } | undefined {
  for (const r of runs) if (n >= r.from && n < r.from + r.count) return { season: r.season, episode: r.episode + n - r.from };
  return undefined;
}

export function absoluteOf(runs: Run[], season: number, episode: number): number | undefined {
  for (const r of runs) if (r.season === season && episode >= r.episode && episode < r.episode + r.count) return r.from + episode - r.episode;
  return undefined;
}

// ---------- verification ----------

export type Verdict = { ok: boolean; reason?: string; matched: number };

/**
 * Do these runs put the right Cinemeta episode on each AniList episode? Checked:
 * · first air date: AniList's start vs the mapped first episode (± 2 days);
 * · counts: aired episodes in the matched range vs AniList's (a few missing at the very end are a
 *   listing that lags; absolute numbering allows no difference at all: one missing episode
 *   anywhere shifts every title after it);
 * · when AniList has no day for the start, the counts must match exactly.
 */
export function verifyRuns(
  entry: Pick<SeasonEntry, 'episodes' | 'start' | 'ongoing'>,
  runs: Run[],
  show: ShowEpisode[],
  { today, absolute }: { today: string; absolute: boolean },
): Verdict {
  const n = entry.episodes;
  if (!n || !runs.length) return { ok: false, reason: 'empty', matched: 0 };
  const idx = indexShow(show);
  let matched = 0;
  for (let i = 1; i <= n; i++) {
    const p = pairOf(runs, i);
    const x = p && idx.get(key(p.season, p.episode));
    if (x?.date && x.date <= today) matched++;
  }
  const first = pairOf(runs, 1);
  const head = first && idx.get(key(first.season, first.episode));
  if (entry.start && head?.date && daysBetween(entry.start, head.date) > DATE_SLACK_DAYS) return { ok: false, reason: 'start', matched };
  const exact = !entry.start || !head?.date;
  if (absolute) {
    const aired = airedRegular(show, today).length;
    if (aired !== n || matched !== n) return { ok: false, reason: 'count', matched };
    return { ok: true, matched };
  }
  const missing = n - matched;
  const slack = exact ? 0 : entry.ongoing ? Math.max(2, Math.ceil(n * 0.05)) : Math.max(1, Math.floor(n * 0.1));
  if (missing > slack) return { ok: false, reason: 'count', matched };
  return { ok: true, matched };
}

/**
 * Pairs from another source (anime-kitsu) checked against Cinemeta itself: every pair must exist
 * there, in order, with the same air date (± 2 days), and cover nearly every AniList episode.
 */
export function verifyPairs(
  pairs: { n: number; season?: number | null; episode?: number | null; date?: string }[],
  show: ShowEpisode[],
  count: number,
): boolean {
  const idx = indexShow(show);
  let covered = 0;
  let late = 0;
  let prev = -1;
  for (const p of [...pairs].sort((a, b) => a.n - b.n)) {
    if (p.n < 1 || p.n > count || !p.season || !p.episode) continue;
    const x = idx.get(key(p.season, p.episode));
    if (!x) return false;
    const k = key(p.season, p.episode);
    if (k <= prev) return false;
    prev = k;
    // A few odd dates on either side (One Piece 102–104) are noise; a shifted table is off
    // by a week on nearly every episode.
    if (p.date && x.date && daysBetween(p.date, x.date) > DATE_SLACK_DAYS) late++;
    covered++;
  }
  const slack = Math.max(2, Math.ceil(count * 0.01));
  return count > 0 && covered >= count - slack && late <= slack;
}

export function infoOf(runs: Run[], idx: Map<number, ShowEpisode>, n: number): EpisodeInfo | undefined {
  const p = pairOf(runs, n);
  if (!p) return undefined;
  const x = idx.get(key(p.season, p.episode));
  return { season: p.season, episode: p.episode, title: x?.title, date: x?.date };
}

// ---------- grouping ----------

const PART_PATTERNS: [RegExp, (m: RegExpMatchArray) => number][] = [
  [/\s*[:\-–—]?\s*(?:part|partie|cour)\s*\.?\s*(\d+)\s*$/i, (m) => Number(m[1])],
  [/\s*[:\-–—]?\s*(?:part|partie|cour)\s+(i{1,3}|iv|v)\s*$/i, (m) => ROMAN[m[1].toLowerCase()]],
  [/\s*[:\-–—]?\s*(\d+)\s*(?:st|nd|rd|th|e|ème)\s+(?:part|cour|partie)\s*$/i, (m) => Number(m[1])],
  [/\s*第\s*(\d+)\s*クール\s*$/, (m) => Number(m[1])],
  [/\s*[:\-–—]?\s*(?:kouhen|kōhen|後編)\s*$/i, () => 2],
  [/\s*[:\-–—]?\s*(?:zenpen|前編)\s*$/i, () => 1],
];
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };

/** "Attack on Titan Final Season Part 2" → { base: "Attack on Titan Final Season", part: 2 }. */
export function partOf(title: string): { base: string; part?: number } {
  for (const [re, num] of PART_PATTERNS) {
    const m = title.match(re);
    if (m && m.index! > 0) return { base: title.slice(0, m.index).trim(), part: num(m) };
  }
  return { base: title.trim() };
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');

/** Same season as the previous entry? `undefined` when no signal decides. */
function sameSeason(prev: SeasonEntry, cur: SeasonEntry): boolean {
  const a = prev.map;
  const b = cur.map;
  // a. TheTVDB: same show, same season (> 0) = same season; two different seasons never merge.
  if (a?.imdb && b?.imdb && a.imdb === b.imdb && a.season != null && b.season != null) {
    return a.season > 0 && a.season === b.season;
  }
  // b. "Part 2" / "Cour 2" of the same base title.
  const p = partOf(cur.title);
  if (!p.part || p.part < 2) return false;
  return norm(p.base) === norm(partOf(prev.title).base);
}

export type SeasonGroup = { entries: SeasonEntry[] };

/** Consecutive entries that are parts of one season, in airing order. */
export function groupEntries(entries: SeasonEntry[]): SeasonGroup[] {
  const out: SeasonGroup[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && sameSeason(last.entries[last.entries.length - 1], e)) last.entries.push(e);
    else out.push({ entries: [e] });
  }
  return out;
}

/**
 * Season numbers: TheTVDB's when every known one goes up (missing ones continue from the
 * previous), else 1, 2, 3… in airing order.
 */
export function seasonNumbers(groups: SeasonGroup[]): number[] {
  const tvdb = groups.map((g) => {
    const m = g.entries.find((e) => e.map?.season != null && e.map.season > 0)?.map;
    return m?.season;
  });
  const out: number[] = [];
  let prev = 0;
  for (const t of tvdb) {
    const n = t ?? prev + 1;
    if (n <= prev) return groups.map((_, i) => i + 1);
    out.push(n);
    prev = n;
  }
  return out;
}

// ---------- the season model ----------

export type SeasonPart = {
  seriesId: string;
  /** AniList episode numbers of this series in the season (inclusive). */
  from: number;
  to: number;
  /** Number shown for `from` inside the season (parts continue: Part 2 ep. 1 = ép. 17). */
  shownFrom: number;
  /** "Partie 2" when the season has several parts. */
  label?: string;
};

export type DisplaySeason = {
  key: string;
  /** "Saison 4", or the show's title when the franchise spans several shows (Naruto → Boruto). */
  label: string;
  /** Season number shown in badges ("S4"), undefined for shows labelled by title. */
  number?: number;
  parts: SeasonPart[];
  count: number;
  /** First and last air dates (YYYY-MM-DD) when known, else the year. */
  from?: string;
  to?: string;
  year?: number;
  /** A TheTVDB season of a long entry: rows keep the absolute numbers (One Piece ép. 1000). */
  absolute?: boolean;
  /** Section title shown above this row in the picker (sub-seasons of a show among several). */
  header?: string;
  /** Show these sub-seasons belong to, when the franchise spans several shows. */
  show?: string;
};

export type SubSeasonInput = { entry: SeasonEntry; runs: Run[]; show: ShowEpisode[] };

/**
 * TheTVDB seasons covering a long entry: contiguous ranges of its absolute episodes. Episodes
 * without a pair (moved to the specials, or not listed yet) join the season around them; ones
 * past the listing join the last season. Less than two seasons: none.
 */
export function subSeasons({ entry, runs, show }: SubSeasonInput): { season: number; from: number; to: number; first?: string; last?: string }[] {
  const n = entry.episodes;
  if (n <= LONG_ENTRY || !runs.length) return [];
  const idx = indexShow(show);
  const out: { season: number; from: number; to: number; first?: string; last?: string }[] = [];
  for (let i = 1; i <= n; i++) {
    const p = pairOf(runs, i);
    const last = out[out.length - 1];
    if (!p || (last && p.season === last.season)) {
      if (last) last.to = i;
      else if (p) out.push({ season: p.season, from: i, to: i });
      else continue;
    } else {
      out.push({ season: p.season, from: i, to: i });
    }
    const x = p && idx.get(key(p.season, p.episode));
    const cur = out[out.length - 1];
    if (x?.date) {
      cur.first ??= x.date;
      cur.last = x.date;
    }
  }
  if (out.length && out[0].from > 1) out[0].from = 1;
  // A season seen twice (data out of order): not trustworthy as navigation.
  if (new Set(out.map((x) => x.season)).size !== out.length) return [];
  return out.length >= 2 ? out : [];
}

export type ModelInput = {
  /** Seasons of the franchise in airing order (AniList entries). */
  entries: SeasonEntry[];
  /** Entry whose page is open. */
  currentId: string;
  /** Sub-seasons of the current entry when it is long and verified. */
  sub?: { season: number; from: number; to: number; first?: string; last?: string }[];
};

/** Picker rows: grouped seasons, the current long entry expanded into its TheTVDB seasons. */
export function buildSeasons({ entries, currentId, sub }: ModelInput): DisplaySeason[] {
  const groups = groupEntries(entries.filter((e) => e.episodes > 0));
  const numbers = seasonNumbers(groups);
  const shows = new Set(entries.map((e) => e.map?.imdb).filter(Boolean));
  const byTitle = shows.size > 1;
  const out: DisplaySeason[] = [];
  groups.forEach((g, gi) => {
    const first = g.entries[0];
    if (sub?.length && g.entries.length === 1 && first.id === currentId) {
      sub.forEach((x, i) =>
        out.push({
          key: `${first.id}:s${x.season}`,
          label: `Saison ${x.season}`,
          number: x.season,
          parts: [{ seriesId: first.id, from: x.from, to: x.to, shownFrom: x.from }],
          count: x.to - x.from + 1,
          from: x.first,
          to: x.last,
          year: x.first ? Number(x.first.slice(0, 4)) : undefined,
          absolute: true,
          show: byTitle ? partOf(first.title).base : undefined,
          header: byTitle && i === 0 ? partOf(first.title).base : undefined,
        }),
      );
      return;
    }
    let shown = 1;
    const parts = g.entries.map((e, i) => {
      const part: SeasonPart = {
        seriesId: e.id,
        from: 1,
        to: e.episodes,
        shownFrom: shown,
        label: g.entries.length > 1 ? `Partie ${i + 1}` : undefined,
      };
      shown += e.episodes;
      return part;
    });
    const number = byTitle ? undefined : numbers[gi];
    out.push({
      key: g.entries.map((e) => e.id).join('+'),
      label: number ? `Saison ${number}` : partOf(first.title).base,
      number,
      parts,
      count: shown - 1,
      from: first.start,
      year: first.year,
    });
  });
  return out;
}

/** The season holding an episode of a series (the first one when none does). */
export function seasonOf(seasons: DisplaySeason[], seriesId: string, n: number): DisplaySeason | undefined {
  return (
    seasons.find((s) => s.parts.some((p) => p.seriesId === seriesId && n >= p.from && n <= p.to)) ??
    seasons.find((s) => s.parts.some((p) => p.seriesId === seriesId))
  );
}

/** Number shown for an episode inside its season (continues across parts). */
export function shownNumber(season: DisplaySeason | undefined, seriesId: string, n: number): number {
  const p = season?.parts.find((x) => x.seriesId === seriesId && n >= x.from && n <= x.to);
  return p ? p.shownFrom + n - p.from : n;
}

/** "S4 Ép. 17", "l’ép. 1000", "l’ép. 12 (Naruto)": an episode in the chronology of specials. */
export function chronologyName(season: DisplaySeason, shown: number): string {
  if (season.number && !season.absolute) return `S${season.number} Ép. ${shown}`;
  const show = season.show ?? (season.number ? undefined : season.label);
  return `l’ép. ${shown}${show ? ` (${show})` : ''}`;
}

/** "S4 · Ép. 17" (with several seasons), "Ép. 3" otherwise. */
export function episodeBadge(season: DisplaySeason | undefined, seriesId: string, n: number, seasons: number): string {
  const ep = `Ép. ${shownNumber(season, seriesId, n)}`;
  return season?.number && seasons > 1 ? `S${season.number} · ${ep}` : ep;
}

/** "oct. 2019 – nov. 2023 · 194 ép." style detail of a picker row. */
export function seasonDetail(s: DisplaySeason, fmt: (iso: string) => string): string {
  const range = s.from && s.to && s.from.slice(0, 7) !== s.to.slice(0, 7) ? `${fmt(s.from)} – ${fmt(s.to)}` : s.from ? fmt(s.from) : s.year ? String(s.year) : '';
  const parts = s.parts.length > 1 ? `${s.parts.length} parties` : '';
  return [range, `${s.count} ép.`, parts].filter(Boolean).join(' · ');
}

// ---------- specials ----------

export type SpecialItem = {
  anilistId: number;
  title: string;
  format: string | null;
  episodes: number | null;
  /** YYYY-MM-DD when the day is known. */
  start?: string;
  year?: number;
  image?: string;
};

/** Specials in airing order (undated last), each once. */
export function sortSpecials(items: SpecialItem[], exclude: Set<number>): SpecialItem[] {
  const seen = new Set<number>();
  const out = items.filter((x) => !exclude.has(x.anilistId) && !seen.has(x.anilistId) && seen.add(x.anilistId));
  const at = (x: SpecialItem) => x.start ?? (x.year ? `${x.year}-12-31` : '9999');
  return out.sort((a, b) => at(a).localeCompare(at(b)) || a.anilistId - b.anilistId);
}

/**
 * Where a special falls in the show: the last episode aired before it ("après S2 Ép. 12", or
 * "après l'ép. 207" for absolute numbering), "avant l'ép. 1" before the show. Needs both dates.
 */
export function chronologyLabel(
  date: string | undefined,
  episodes: { date?: string; label: string }[],
  open = false,
): string | undefined {
  if (!date) return undefined;
  const dated = episodes.filter((x) => x.date);
  if (!dated.length) return undefined;
  if (date < dated[0].date!) return `avant ${dated[0].label}`;
  let last: { label: string } | undefined;
  for (const x of dated) {
    if (x.date! <= date) last = x;
    else break;
  }
  // Past the last listed episode of a show still airing: not placed (the listing may be behind).
  if (open && last === dated[dated.length - 1]) return undefined;
  return last ? `après ${last.label}` : undefined;
}

// ---------- everything together ----------

export type ComposeInput = {
  /** Seasons of the franchise in airing order, with their IMDb numbering when resolved. */
  entries: SeasonEntry[];
  currentId: string;
  /** Cinemeta listings by IMDb id (missing: not loaded, null: unavailable). */
  shows: Record<string, ShowEpisode[] | null | undefined>;
  /** anime-kitsu absolute ↔ IMDb pairs of the current entry, when asked for (`wantPairs`). */
  pairs?: { n: number; season?: number | null; episode?: number | null; date?: string }[] | null;
  /** YYYY-MM-DD */
  today: string;
};

export type Mapping = { runs: Run[]; source: 'season' | 'absolute' | 'pairs' };

export type Composed = {
  seasons: DisplaySeason[];
  /** Verified numbering per series id: only these get Cinemeta titles and dates. */
  mappings: Record<string, Mapping>;
  /** Why an entry got no titles (debug, tests). */
  rejected: Record<string, string>;
  /** The current entry's absolute numbering does not line up: the anime-kitsu table may fix it. */
  wantPairs: boolean;
};

export function composeSeasons({ entries, currentId, shows, pairs, today }: ComposeInput): Composed {
  const mappings: Record<string, Mapping> = {};
  const rejected: Record<string, string> = {};
  let wantPairs = false;
  for (const e of entries) {
    const map = e.map;
    const show = map?.imdb ? shows[map.imdb] : undefined;
    if (!map?.imdb || !show || e.episodes <= 0) continue;
    if (map.season != null) {
      if (map.season <= 0) {
        rejected[e.id] = 'specials';
        continue;
      }
      const runs = seasonRuns(e.episodes, map.season, map.offset ?? 0);
      const v = verifyRuns(e, runs, show, { today, absolute: false });
      if (v.ok) mappings[e.id] = { runs, source: 'season' };
      else rejected[e.id] = v.reason ?? 'mismatch';
      continue;
    }
    // Absolute numbering over the whole show: only when no other season shares the IMDb id.
    if (entries.some((x) => x !== e && x.map?.imdb === map.imdb)) {
      rejected[e.id] = 'shared';
      continue;
    }
    const runs = cumulativeRuns(show, e.episodes);
    const v = verifyRuns(e, runs, show, { today, absolute: true });
    if (v.ok) {
      mappings[e.id] = { runs, source: 'absolute' };
      continue;
    }
    rejected[e.id] = v.reason ?? 'mismatch';
    if (v.reason !== 'count' || e.id !== currentId) continue;
    wantPairs = true;
    if (pairs?.length && verifyPairs(pairs, show, e.episodes)) {
      mappings[e.id] = { runs: runsFromPairs(pairs, e.episodes), source: 'pairs' };
      delete rejected[e.id];
    }
  }
  // Two entries on the same TheTVDB episodes: at least one is wrong, neither is trusted.
  const owner = new Map<string, string>();
  const clash = new Set<string>();
  for (const [id, m] of Object.entries(mappings)) {
    const imdb = entries.find((x) => x.id === id)?.map?.imdb ?? '';
    for (const r of m.runs) {
      for (let i = 0; i < r.count; i++) {
        const slot = `${imdb}:${r.season}:${r.episode + i}`;
        const other = owner.get(slot);
        if (other && other !== id) clash.add(other).add(id);
        else owner.set(slot, id);
      }
    }
  }
  for (const id of clash) {
    delete mappings[id];
    rejected[id] = 'overlap';
  }
  const current = entries.find((x) => x.id === currentId);
  const cur = mappings[currentId];
  const sub =
    current?.map?.imdb && cur && cur.source !== 'season' ? subSeasons({ entry: current, runs: cur.runs, show: shows[current.map.imdb] ?? [] }) : undefined;
  return { seasons: buildSeasons({ entries, currentId, sub }), mappings, rejected, wantPairs };
}

// ---------- one episode outside the anime page ----------

/**
 * Verified absolute ↔ IMDb numbering of one entry on its own, for addon requests (One Piece
 * ep. 1000 = tt0388629:21:109, the numbering Torrentio uses): the picker's checks without the
 * rest of the franchise. Undefined when not verified; an episode without a slot there (One Piece
 * 590, moved to TheTVDB's specials, has no pair in the anime-kitsu table either) has no IMDb id.
 * The anime-kitsu table goes first when it lines up with Cinemeta: it is the one Torrentio reads,
 * and an absolute listing can line up by chance (AniList one episode behind while one episode
 * sits in the specials: every id after it would be one off).
 * `wantPairs`: the anime-kitsu table may verify it (absolute numbering off by an episode).
 */
export function verifiedRuns(
  entry: SeasonEntry,
  show: ShowEpisode[] | null | undefined,
  pairs: ComposeInput['pairs'],
  today: string,
): { runs?: Run[]; wantPairs: boolean } {
  const imdb = entry.map?.imdb;
  if (!imdb || !show || entry.episodes <= 0) return { wantPairs: false };
  if (entry.map?.season == null && pairs?.length && verifyPairs(pairs, show, entry.episodes)) {
    return { runs: runsFromPairs(pairs, entry.episodes), wantPairs: false };
  }
  const out = composeSeasons({ entries: [entry], currentId: entry.id, shows: { [imdb]: show }, pairs, today });
  const m = out.mappings[entry.id];
  return { runs: m?.runs, wantPairs: !m && out.wantPairs };
}

/**
 * TheTVDB slot of an episode not aired yet (the "À venir" rows), past the last mapped one: the
 * episodes Cinemeta lists after that slot, in order (air date within 2 days when both are known),
 * then the same season continued. Undefined inside a hole of the mapping or when Cinemeta's date
 * disagrees.
 */
export function upcomingPair(runs: Run[], show: ShowEpisode[], n: number, date?: string): { season: number; episode: number } | undefined {
  const p = pairOf(runs, n);
  if (p) return p;
  let lastN = 0;
  let last: { s: number; e: number } | undefined;
  for (const r of runs) {
    const end = r.from + r.count - 1;
    if (end > lastN) {
      lastN = end;
      last = { s: r.season, e: r.episode + r.count - 1 };
    }
  }
  if (!last || n <= lastN) return undefined;
  const k = n - lastN;
  const from = key(last.s, last.e);
  const after = show.filter((x) => x.s > 0 && key(x.s, x.e) > from).sort((a, b) => a.s - b.s || a.e - b.e);
  const x = after[k - 1];
  if (x) return !date || !x.date || daysBetween(date, x.date) <= DATE_SLACK_DAYS ? { season: x.s, episode: x.e } : undefined;
  const base = after[after.length - 1] ?? last;
  return { season: base.s, episode: base.e + k - after.length };
}

// ---------- labels outside the anime page (buttons, cards) ----------

/**
 * Seasons of a franchise for "Regarder · S4 Ép. 17" and cards: parts grouped, TheTVDB numbers
 * once every entry's mapping is known (title signals alone before, so a label never comes from
 * a half-loaded mapping). No Cinemeta here: a long entry stays one season.
 */
export function labelSeasons(entries: SeasonEntry[]): DisplaySeason[] {
  const known = entries.every((e) => e.map !== undefined);
  return buildSeasons({
    entries: entries.map((e) => ({ ...e, episodes: Math.max(1, e.episodes), map: known ? e.map : undefined })),
    currentId: '',
  });
}

/** Season number of a series (1 when it is alone), position among the seasons when labelled by title. */
export function seasonNumberIn(seasons: DisplaySeason[], seriesId: string, n = 1): number {
  const s = seasonOf(seasons, seriesId, n);
  return s ? (s.number ?? seasons.indexOf(s) + 1) : 1;
}

/** Season (several seasons only) and number shown of an episode: "S4 Ép. 17" for AoT Final Season Part 2 ep. 1. */
export function episodeNumbering(seasons: DisplaySeason[], seriesId: string, n: number): { season?: number; shown: number } {
  const s = seasonOf(seasons, seriesId, n);
  if (!s) return { shown: n };
  return { season: seasons.length > 1 ? seasonNumberIn(seasons, seriesId, n) : undefined, shown: shownNumber(s, seriesId, n) };
}
