// Episode numbering of split-cour shows on TheTVDB / IMDb.
// AniList / Kitsu / MAL number each part from 1 ("Spy x Family Part 2" ep. 1), while IMDb ids
// (what aggregators like AIOStreams or Torrentio look up through Cinemeta) follow TheTVDB, where
// that part is season 1 episode 13. ARM gives the TheTVDB season but no episode offset; the
// Fribb anime-lists mapping does (`episode_offset.tvdb`), keyed by AniDB id.
//   https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-lists-reduced.json
//   (~1.2 MB, ~120 KB gzipped; fetched lazily, at most once a week)
// Only the entries that carry an offset are kept (~640, ~9 KB), cached on disk.
import AsyncStorage from '@react-native-async-storage/async-storage';

export type EpisodeMapping = {
  /** TheTVDB season (also the IMDb season in Cinemeta). */
  tvdbSeason?: number;
  /** Add to the AniList episode number to get the TheTVDB episode number in `tvdbSeason`. */
  tvdbOffset?: number;
  /** TMDB numbering, sometimes absolute (whole show in one season). */
  tmdbSeason?: number;
  tmdbOffset?: number;
};

/** anidb id → [tvdbSeason, tvdbOffset, tmdbSeason, tmdbOffset] (0 = unknown). */
export type OffsetIndex = Record<string, [number, number, number, number]>;

type FribbEntry = {
  anidb_id?: number;
  season?: { tvdb?: number; tmdb?: number };
  episode_offset?: { tvdb?: number; tmdb?: number };
};

const URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-lists-reduced.json';
const KEY = 'huwa/episode-offsets/v1';
const TTL = 7 * 86400e3;
/** A failed download is retried after this long. */
const RETRY_MS = 3600e3;

/** Keeps only what changes the numbering: entries with an episode offset. */
export function buildOffsetIndex(list: FribbEntry[]): OffsetIndex {
  const out: OffsetIndex = {};
  for (const e of list) {
    const o = e.episode_offset;
    if (!e.anidb_id || !o || (!o.tvdb && !o.tmdb)) continue;
    out[e.anidb_id] = [e.season?.tvdb ?? 0, o.tvdb ?? 0, e.season?.tmdb ?? 0, o.tmdb ?? 0];
  }
  return out;
}

export function mappingFrom(index: OffsetIndex | null | undefined, anidb: number | undefined): EpisodeMapping | null {
  const row = anidb ? index?.[anidb] : undefined;
  if (!row) return null;
  const [ts, to, ms, mo] = row;
  return {
    tvdbSeason: ts || undefined,
    tvdbOffset: to || undefined,
    tmdbSeason: ms || undefined,
    tmdbOffset: mo || undefined,
  };
}

type Stored = { at: number; index: OffsetIndex };
let mem: Stored | null = null;
let loading: Promise<OffsetIndex | null> | null = null;
let failedAt = 0;

async function download(): Promise<OffsetIndex> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return buildOffsetIndex((await res.json()) as FribbEntry[]);
  } finally {
    clearTimeout(timer);
  }
}

/** The offset index (disk, then network when older than a week); null when unavailable. */
export function loadOffsetIndex(): Promise<OffsetIndex | null> {
  if (mem && Date.now() - mem.at < TTL) return Promise.resolve(mem.index);
  if (loading) return loading;
  loading = (async () => {
    if (!mem) {
      try {
        const raw = await AsyncStorage.getItem(KEY);
        if (raw) mem = JSON.parse(raw) as Stored;
      } catch {
        // corrupt: download again
      }
    }
    if (mem && Date.now() - mem.at < TTL) return mem.index;
    if (Date.now() - failedAt < RETRY_MS) return mem?.index ?? null;
    try {
      const index = await download();
      mem = { at: Date.now(), index };
      AsyncStorage.setItem(KEY, JSON.stringify(mem)).catch(() => {});
      return index;
    } catch {
      failedAt = Date.now();
      // Stale index is better than none.
      return mem?.index ?? null;
    }
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/** Mapping for an AniDB id, waiting at most `timeoutMs` for the index (first run). */
export async function episodeMapping(anidb: number | undefined, timeoutMs = 4000): Promise<EpisodeMapping | null> {
  if (!anidb) return null;
  if (mem) {
    // Refresh in the background when old, answer from what is there.
    if (Date.now() - mem.at >= TTL) void loadOffsetIndex();
    return mappingFrom(mem.index, anidb);
  }
  const index = await Promise.race([loadOffsetIndex(), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
  return mappingFrom(index, anidb);
}
