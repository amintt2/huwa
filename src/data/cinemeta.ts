// Episode listings of IMDb shows from Stremio's Cinemeta (free, no key, TheTVDB data):
//   GET https://v3-cinemeta.strem.io/meta/series/tt0388629.json → meta.videos[] { season, episode, name, released }
// Same numbering as Torrentio and most Stremio addons for IMDb ids. Compacted (season, episode,
// title, air date) and cached on disk: 7 days, stale copy kept for offline use.
// When an absolute numbering does not line up (TheTVDB moved One Piece 590 to the specials),
// the absolute ↔ IMDb table of Stremio's anime-kitsu addon is used instead, checked against
// Cinemeta (data/seasons.ts `verifyPairs`):
//   GET https://anime-kitsu.strem.fun/meta/series/kitsu:12.json → videos[] { episode, imdbSeason, imdbEpisode, released }
import AsyncStorage from '@react-native-async-storage/async-storage';

import { compactVideos, jstDate, type ShowEpisode } from './seasons';

const CINEMETA = 'https://v3-cinemeta.strem.io/meta/series';
const KITSU_ADDON = 'https://anime-kitsu.strem.fun/meta/series';
const PREFIX = 'huwa/cinemeta/v1/';
const INDEX_KEY = 'huwa/cinemeta/v1#index';
const TTL = 7 * 86400e3;
/** A failed fetch is retried after this long (the stale copy, if any, is served meanwhile). */
const RETRY_MS = 30 * 60e3;
/** Shows kept on disk (One Piece is ~70 KB compacted). */
const MAX_KEPT = 40;

/** Disk form: [season, episode, title, date] (a ~10× smaller listing than Cinemeta's JSON). */
type Row = [number, number, string?, string?];
type Stored<T> = { at: number; v: T };

export type KitsuPair = { n: number; season?: number | null; episode?: number | null; date?: string };
type PairRow = [number, number, number, string?];

const mem = new Map<string, Stored<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const failedAt = new Map<string, number>();

async function touchIndex(key: string) {
  try {
    const raw = await AsyncStorage.getItem(INDEX_KEY);
    const index: Record<string, number> = raw ? JSON.parse(raw) : {};
    index[key] = Date.now();
    const old = Object.entries(index).sort((a, b) => b[1] - a[1]).slice(MAX_KEPT);
    for (const [k] of old) {
      delete index[k];
      mem.delete(k);
      AsyncStorage.removeItem(PREFIX + k).catch(() => {});
    }
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // index lost: entries are rebuilt on use
  }
}

/** Fresh copy, else the network, else the stale copy; null when nothing is available. */
async function cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  let hit = mem.get(key) as Stored<T> | undefined;
  if (!hit) {
    try {
      const raw = await AsyncStorage.getItem(PREFIX + key);
      if (raw) {
        hit = JSON.parse(raw) as Stored<T>;
        mem.set(key, hit);
      }
    } catch {
      // corrupt: fetch again
    }
  }
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  if (Date.now() - (failedAt.get(key) ?? 0) < RETRY_MS) return hit?.v ?? null;
  let job = inflight.get(key) as Promise<T | null> | undefined;
  if (!job) {
    job = load()
      .then((v) => {
        if (v == null) throw new Error('empty');
        const stored = { at: Date.now(), v };
        mem.set(key, stored);
        AsyncStorage.setItem(PREFIX + key, JSON.stringify(stored)).catch(() => {});
        void touchIndex(key);
        return v;
      })
      .catch(() => {
        failedAt.set(key, Date.now());
        return hit?.v ?? null; // offline: the stale listing is still right for aired episodes
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return job;
}

async function getJson<T>(url: string, timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

type CinemetaMeta = { meta?: { videos?: { season?: number; episode?: number; name?: string; title?: string; released?: string; firstAired?: string }[] } };

/** Every episode of an IMDb show (specials = season 0), null when unavailable. */
export async function showEpisodes(imdb: string): Promise<ShowEpisode[] | null> {
  if (!/^tt\d+$/.test(imdb)) return null;
  const rows = await cached<Row[]>(imdb, async () => {
    const json = await getJson<CinemetaMeta>(`${CINEMETA}/${imdb}.json`);
    const eps = compactVideos(json.meta?.videos ?? []);
    return eps.length ? eps.map((x): Row => [x.s, x.e, x.title, x.date]) : null;
  });
  return rows?.map(([s, e, title, date]) => ({ s, e, title: title ?? undefined, date: date ?? undefined })) ?? null;
}

type KitsuMeta = { meta?: { videos?: { episode?: number; imdbSeason?: number; imdbEpisode?: number; released?: string }[] } };

/** Absolute episode → IMDb season / episode, from the anime-kitsu addon; null when unavailable. */
export async function kitsuPairs(kitsu: number): Promise<KitsuPair[] | null> {
  const rows = await cached<PairRow[]>(`kitsu:${kitsu}`, async () => {
    const json = await getJson<KitsuMeta>(`${KITSU_ADDON}/kitsu:${kitsu}.json`);
    const out: PairRow[] = [];
    for (const v of json.meta?.videos ?? []) {
      if (typeof v.episode === 'number' && v.imdbSeason && v.imdbEpisode) out.push([v.episode, v.imdbSeason, v.imdbEpisode, jstDate(v.released)]);
    }
    return out.length ? out : null;
  });
  return rows?.map(([n, season, episode, date]) => ({ n, season, episode, date: date ?? undefined })) ?? null;
}
