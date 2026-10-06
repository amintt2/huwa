// Which episode notifications to schedule (pure part of notifications/episodes.ts, unit-tested).
// The scheduled set is "Ma liste" (when the global setting is on) ∪ the series with a bell
// (« Me rappeler ») ∪ the single episodes with a bell, deduplicated, soonest first, capped
// under iOS's 64 pending local notifications.

/** A bell on one not-yet-aired episode (`airingAt` in unix seconds, as known when it was set). */
export type EpisodeReminder = { seriesId: string; episode: number; airingAt: number };

/** One episode to notify (AniList's schedule, `airingAt` in unix seconds). */
export type PlannedEpisode = { anilistId: number; title: string; episode: number; airingAt: number };

/** iOS keeps at most 64 pending local notifications per app. */
export const MAX_SCHEDULED = 60;
/** An episode airing within the next minute is not worth scheduling. */
export const MIN_LEAD_MS = 60_000;

export const reminderKey = (seriesId: string, episode: number) => `${seriesId}:${episode}`;

/** AniList anime id of a series id (`al123`), null for anything else (manhwa, demo series). */
export function anilistIdOf(seriesId: string): number | null {
  const m = /^al(\d+)$/.exec(seriesId);
  return m ? Number(m[1]) : null;
}

export type PlanSources = {
  /** "Ma liste" (series ids). */
  myList: readonly string[];
  /** Global "Nouveaux épisodes" setting: off, "Ma liste" is not notified (bells still are). */
  listEnabled: boolean;
  /** Series with « Me rappeler » on. */
  seriesReminders: readonly string[];
  /** Single episodes with a bell. */
  episodeReminders: Readonly<Record<string, EpisodeReminder>>;
};

/** Every series follows its whole schedule (list + series bells). */
function followed(src: PlanSources): Set<number> {
  const ids = [...(src.listEnabled ? src.myList : []), ...src.seriesReminders].map(anilistIdOf);
  return new Set(ids.filter((x): x is number => x !== null));
}

/** AniList ids whose next airings have to be fetched, each once. */
export function idsToFetch(src: PlanSources): number[] {
  const ids = followed(src);
  for (const r of Object.values(src.episodeReminders)) {
    const id = anilistIdOf(r.seriesId);
    if (id !== null) ids.add(id);
  }
  return [...ids];
}

/**
 * The notifications to schedule, soonest first, at most `max`. `upcoming` is what AniList (or
 * the offline cache) says airs next; an episode bell keeps its stored time unless the schedule
 * knows a fresher one. `titleOf` names an episode bell AniList did not return.
 */
export function planNotifications(
  src: PlanSources,
  upcoming: readonly PlannedEpisode[],
  opts: { now?: number; max?: number; titleOf?: (seriesId: string) => string | undefined } = {},
): PlannedEpisode[] {
  const now = opts.now ?? Date.now();
  const max = opts.max ?? MAX_SCHEDULED;
  const follow = followed(src);
  const byKey = new Map<string, PlannedEpisode>();
  const fresh = new Map<string, PlannedEpisode>();
  for (const u of upcoming) fresh.set(`${u.anilistId}-${u.episode}`, u);

  for (const u of fresh.values()) if (follow.has(u.anilistId)) byKey.set(`${u.anilistId}-${u.episode}`, u);
  for (const r of Object.values(src.episodeReminders)) {
    const id = anilistIdOf(r.seriesId);
    if (id === null) continue;
    const key = `${id}-${r.episode}`;
    if (byKey.has(key)) continue;
    const known = fresh.get(key);
    byKey.set(key, known ?? { anilistId: id, episode: r.episode, airingAt: r.airingAt, title: opts.titleOf?.(r.seriesId) ?? '' });
  }

  return [...byKey.values()]
    .filter((u) => u.airingAt * 1000 > now + MIN_LEAD_MS)
    .sort((a, b) => a.airingAt - b.airingAt || a.anilistId - b.anilistId || a.episode - b.episode)
    .slice(0, max);
}

/**
 * Episode bells with the airing time AniList now announces (an episode can be pushed back a
 * week). Same object when nothing changes.
 */
export function refreshEpisodeReminders<T extends Record<string, EpisodeReminder>>(reminders: T, upcoming: readonly PlannedEpisode[]): T {
  const times = new Map(upcoming.map((u) => [`${u.anilistId}-${u.episode}`, u.airingAt]));
  let changed = false;
  const out = Object.fromEntries(
    Object.entries(reminders).map(([k, r]) => {
      const t = times.get(`${anilistIdOf(r.seriesId)}-${r.episode}`);
      if (t === undefined || t === r.airingAt) return [k, r];
      changed = true;
      return [k, { ...r, airingAt: t }];
    }),
  );
  return changed ? (out as T) : reminders;
}

/** Episode bells whose episode already aired are dropped. Same object when nothing changes. */
export function pruneEpisodeReminders<T extends Record<string, EpisodeReminder>>(reminders: T, now = Date.now()): T {
  const keep = Object.entries(reminders).filter(([, r]) => r.airingAt * 1000 > now);
  return keep.length === Object.keys(reminders).length ? reminders : (Object.fromEntries(keep) as T);
}
