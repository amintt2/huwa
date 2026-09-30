// Stremio library import, from the file of Stremio's own "Export user data" button
// (web.stremio.com → Settings → "Export user data", which downloads
// https://api.strem.io/data-export/<id>/export.json). Stremio has no public, documented API for
// third-party apps (the account API used by its clients requires the user's password), so Huwa
// only reads the file the user exported himself.
//
// Export layout (observed, see Stremio/stremio-bugs#614): `{ addons, library: [{ _id, d: LibraryItem }] }`.
// LibraryItem (stremio-core): `{ _id, name, type, removed, temp, state: { video_id, timesWatched,
// flaggedWatched, overallTimeWatched, season, episode, … } }`. The parser is tolerant: it walks
// the whole JSON, so bare library arrays or addon collections (`[{ transportUrl, manifest }]`)
// work too.
import type { ListStatus } from '@/data/anilist-api';

export type StremioLibraryItem = {
  id: string;
  type: string;
  name: string;
  status: ListStatus;
  season?: number;
  episode?: number;
};

export type StremioExport = { items: StremioLibraryItem[]; addons: string[] };

type RawState = {
  video_id?: string | null;
  timesWatched?: number;
  flaggedWatched?: number;
  overallTimeWatched?: number;
  timeOffset?: number;
  season?: number;
  episode?: number;
};
type RawItem = { _id?: string; name?: string; type?: string; removed?: boolean; temp?: boolean; state?: RawState };

const TYPES = new Set(['series', 'movie', 'anime']);
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i;

function statusOf(it: RawItem): ListStatus | null {
  const st = it.state ?? {};
  const watchedFlag = (st.flaggedWatched ?? 0) > 0 || (st.timesWatched ?? 0) > 0;
  const inProgress = !!st.video_id || (st.overallTimeWatched ?? 0) > 0 || (st.timeOffset ?? 0) > 0;
  if (it.removed && !it.temp) return null; // explicitly removed from the library
  if (it.type === 'movie') return watchedFlag ? 'COMPLETED' : inProgress ? 'CURRENT' : it.temp ? null : 'PLANNING';
  if (st.video_id || inProgress) return 'CURRENT';
  if (watchedFlag) return 'COMPLETED';
  return it.temp ? null : 'PLANNING';
}

export function parseStremioExport(json: unknown): StremioExport {
  const items = new Map<string, StremioLibraryItem>();
  const addons = new Set<string>();
  const seen = new Set<unknown>();

  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 8 || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    // Addon descriptor.
    if (typeof o.transportUrl === 'string' && /^https?:\/\//i.test(o.transportUrl) && !LOCAL.test(o.transportUrl)) {
      const flags = (o.flags ?? {}) as { protected?: boolean };
      if (!flags.protected) addons.add(o.transportUrl);
      return;
    }
    // Library item (possibly wrapped as `{ _id, d: item }`).
    const it = (o.d && typeof o.d === 'object' ? o.d : o) as RawItem;
    if (typeof it._id === 'string' && typeof it.name === 'string' && typeof it.type === 'string') {
      if (TYPES.has(it.type)) {
        const status = statusOf(it);
        if (status && !items.has(it._id)) {
          items.set(it._id, {
            id: it._id,
            type: it.type,
            name: it.name,
            status,
            season: it.state?.season || undefined,
            episode: it.state?.episode || undefined,
          });
        }
      }
      return;
    }
    for (const x of Object.values(o)) visit(x, depth + 1);
  };

  visit(json, 0);
  return { items: [...items.values()], addons: [...addons] };
}
