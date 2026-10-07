// Streams of another work under the same title, which addons mix into an anime's results:
// Torrentio answers One Piece episode 1 with Netflix's live action ("One Piece S01E01 2023 …
// NF WEB-DL") and with One Pace (a fan re-cut by arc, not the episode). Release names of a
// remake / live action carry their year; an anime episode's release names carry its air year,
// if any. Pure, so it is unit-tested under Node.
import type { StreamItem } from './protocol';

/** Fan re-cuts: arcs re-edited into new "episodes", never the asked episode. */
const FAN_EDIT = /\bone[ ._-]?pace\b/i;
/** A year token: not part of an episode range ("0001-2000") nor of a longer number. */
const YEAR = /(?<![\d~-])(?<!\d[ ._]?[-~][ ._]?)((?:19|20)\d{2})(?!\d)/g;

export type WorkInfo = {
  /** First air year of this season / series. */
  startYear: number;
  /** Episode asked (absolute within the series). */
  episode: number;
  /** Air year of that episode when known (Cinemeta), else estimated from `startYear`. */
  episodeYear?: number;
};

/** Episodes a long-running weekly show airs in a year (estimate when the air date is unknown). */
const PER_YEAR = 45;

/** Years a release of this episode may carry in its name. */
function allowedYears(w: WorkInfo): [number, number] {
  if (w.episodeYear) return [Math.min(w.startYear, w.episodeYear) - 1, w.episodeYear + 1];
  const est = w.startYear + Math.floor(Math.max(0, w.episode - 1) / PER_YEAR);
  // The estimate drifts on long-runners (breaks, recaps): wider margin past the first year.
  const slack = w.episode > PER_YEAR ? 3 : 1;
  return [w.startYear - 1, est + slack];
}

const text = (s: StreamItem) => [s.name, s.title, s.description, s.behaviorHints?.filename].filter(Boolean).join(' ');

/** Why a stream belongs to another work (live action, remake, fan edit), or null. */
export function otherWork(s: StreamItem, w: WorkInfo): 'fan-edit' | 'year' | null {
  const t = text(s);
  if (FAN_EDIT.test(t)) return 'fan-edit';
  const [lo, hi] = allowedYears(w);
  const years = [...t.matchAll(YEAR)].map((m) => Number(m[1]));
  // Any year in range keeps it ("One Piece (1999) 2023 Remux" style names stay).
  if (years.length && !years.some((y) => y >= lo && y <= hi)) return 'year';
  return null;
}
