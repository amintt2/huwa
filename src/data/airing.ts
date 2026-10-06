// Airing schedule of a season, pure part (unit-tested): how many episodes are out, the
// not-yet-aired rows of the anime page and their French dates / countdowns, in local time.
// The catalog (data/anilist.ts `episodeCount`) and the anime page share `airedEpisodeCount`,
// so an episode that airs while the page is open becomes a normal playable row.

/** One entry of AniList's airing schedule (`airingAt` in unix seconds). */
export type AiringNode = { episode: number; airingAt: number };

/**
 * Episodes out at `now`. `total` is the announced count of the season (AniList `episodes`, null
 * while unknown), `next` the next airing (or the last known one when it already passed).
 * A releasing season announces its total long before the last episode airs: the aired count
 * comes from the schedule first.
 */
export function airedEpisodeCount(total: number | null | undefined, next: AiringNode | null | undefined, now = Date.now()): number {
  if (!next) return total ?? 0;
  const aired = next.airingAt * 1000 <= now ? next.episode : next.episode - 1;
  return Math.max(0, total ? Math.min(total, aired) : aired);
}

/** Schedule entries by episode (one each, soonest first). The first list wins on duplicates. */
export function mergeSchedule(...lists: (readonly AiringNode[] | undefined)[]): AiringNode[] {
  const byEp = new Map<number, AiringNode>();
  for (const list of lists) for (const n of list ?? []) if (!byEp.has(n.episode)) byEp.set(n.episode, n);
  return [...byEp.values()].sort((a, b) => a.episode - b.episode);
}

/** First episode still to air, or the last one of the schedule when everything aired. */
export function nextOf(schedule: readonly AiringNode[], now = Date.now()): AiringNode | undefined {
  return schedule.find((n) => n.airingAt * 1000 > now) ?? schedule[schedule.length - 1];
}

/** Episodes out at `now` for a whole schedule. */
export const airedFromSchedule = (total: number | null | undefined, schedule: readonly AiringNode[], now = Date.now()) =>
  airedEpisodeCount(total, nextOf(schedule, now), now);

/** Not-yet-aired episodes of the season, after the aired ones and within its announced total. */
export function upcomingRows(schedule: readonly AiringNode[], aired: number, total: number | null | undefined, now = Date.now()): AiringNode[] {
  return mergeSchedule(schedule).filter((n) => n.episode > aired && n.airingAt * 1000 > now && (!total || n.episode <= total));
}

// ---------- French dates (local time) ----------

const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const DAYS_SHORT = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

const pad = (n: number) => String(n).padStart(2, '0');
const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
/** Calendar days from today to the airing day (0 = today), in local time. */
export const daysUntil = (airingAt: number, now = Date.now()) =>
  Math.round((startOfDay(airingAt * 1000) - startOfDay(now)) / 86_400_000);

/** "17:30" */
export const airingTime = (airingAt: number) => {
  const d = new Date(airingAt * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** "jeudi 9 oct." */
export const airingDate = (airingAt: number) => {
  const d = new Date(airingAt * 1000);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

/** "Ép. 8 · jeudi 9 oct. · 17:30" */
export const upcomingLabel = (n: AiringNode) => `Ép. ${n.episode} · ${airingDate(n.airingAt)} · ${airingTime(n.airingAt)}`;

/** "aujourd’hui 17:30", "demain 17:30", "jeu. 17:30" (within the week), "jeu. 16 oct. 17:30". */
export function shortAiring(airingAt: number, now = Date.now()) {
  const days = daysUntil(airingAt, now);
  const d = new Date(airingAt * 1000);
  const time = airingTime(airingAt);
  if (days <= 0) return `aujourd’hui ${time}`;
  if (days === 1) return `demain ${time}`;
  if (days < 7) return `${DAYS_SHORT[d.getDay()]} ${time}`;
  return `${DAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${time}`;
}

/** "Prochain épisode : Ép. 8 · jeu. 17:30" */
export const nextEpisodeLine = (n: AiringNode, now = Date.now()) => `Prochain épisode : Ép. ${n.episode} · ${shortAiring(n.airingAt, now)}`;

/** Under this, the row shows a live countdown instead of "dans 3 j". */
export const COUNTDOWN_MS = 24 * 3_600_000;

/**
 * "dans 3 j" / "demain" more than 24 h ahead, then a live countdown ("dans 5 h 07 min 09 s",
 * "dans 7 min 09 s", "dans 9 s"), "maintenant" once it is out.
 */
export function relativeAiring(airingAt: number, now = Date.now()) {
  const ms = airingAt * 1000 - now;
  if (ms <= 0) return 'maintenant';
  if (ms >= COUNTDOWN_MS) {
    const days = Math.max(1, daysUntil(airingAt, now));
    return days === 1 ? 'demain' : `dans ${days} j`;
  }
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `dans ${h} h ${pad(m)} min ${pad(s)} s`;
  if (m > 0) return `dans ${m} min ${pad(s)} s`;
  return `dans ${s} s`;
}

/** How often a relative label has to be refreshed: every second in countdown mode. */
export const relativeTick = (airingAt: number, now = Date.now()) => (airingAt * 1000 - now < COUNTDOWN_MS ? 1000 : 60_000);
