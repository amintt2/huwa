// anime-sama import, from the file of the site's own backup button (Profil → "Exporter" →
// `anime-sama_sauvegarde_<date>.json`). Nothing is fetched from anime-sama: Huwa reads the
// user's own list (titles + page URLs), never videos.
//
// File layout (`_app: 'anime-sama', _type: 'sauvegarde-bibliotheque', _version: 1`): `data` holds
// the site's localStorage columns as JSON-encoded parallel arrays:
//   histoNom / histoUrl / histoEp / histoType …  history (watching)
//   watchlistNom / watchlistUrl                  watchlist (planned)
//   favoriNom / favoriUrl                        favourites (planned)
//   vuNom / vuUrl                                seen (completed)
// A raw localStorage dump with the same keys is accepted as well.
import type { ListStatus } from '@/data/anilist-api';

export type AnimeSamaItem = { title: string; url: string; status: ListStatus; manhwa: boolean; episode?: number };

const COLS: { nom: string; url: string; ep?: string; status: ListStatus }[] = [
  { nom: 'vuNom', url: 'vuUrl', status: 'COMPLETED' },
  { nom: 'histoNom', url: 'histoUrl', ep: 'histoEp', status: 'CURRENT' },
  { nom: 'watchlistNom', url: 'watchlistUrl', status: 'PLANNING' },
  { nom: 'favoriNom', url: 'favoriUrl', status: 'PLANNING' },
];

const arr = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
};

const isScanUrl = (u: string) => /\/scans?\/|\/s2\//i.test(u);

/** `/catalogue/<slug>/…` → the series key (one entry per series, not per season/language). */
const seriesKey = (url: string, title: string) => /\/catalogue\/([^/?#]+)/i.exec(url)?.[1]?.toLowerCase() ?? title.toLowerCase();

const titleFromSlug = (url: string) => {
  const slug = /\/catalogue\/([^/?#]+)/i.exec(url)?.[1];
  return slug ? decodeURIComponent(slug).replace(/-/g, ' ') : '';
};

export function isAnimeSamaExport(json: unknown): boolean {
  const o = json as { _app?: string; data?: Record<string, unknown> } | null;
  if (!o || typeof o !== 'object') return false;
  if (o._app === 'anime-sama') return true;
  const d = (o.data ?? o) as Record<string, unknown>;
  return COLS.some((c) => c.url in d);
}

export function parseAnimeSamaExport(json: unknown): AnimeSamaItem[] {
  const o = json as { data?: Record<string, unknown> } & Record<string, unknown>;
  const data = (o?.data && typeof o.data === 'object' ? o.data : o) as Record<string, unknown>;
  const out = new Map<string, AnimeSamaItem>();
  for (const col of COLS) {
    const noms = arr(data[col.nom]);
    const urls = arr(data[col.url]);
    const eps = col.ep ? arr(data[col.ep]) : [];
    urls.forEach((u, i) => {
      if (typeof u !== 'string' || !u) return;
      const raw = typeof noms[i] === 'string' ? (noms[i] as string).trim() : '';
      const title = raw || titleFromSlug(u);
      if (!title) return;
      const manhwa = isScanUrl(u);
      const key = `${manhwa ? 'scan' : 'anime'}|${seriesKey(u, title)}`;
      if (out.has(key)) return; // first column wins: seen > history > watchlist > favourites
      const epText = eps[i];
      const episode = typeof epText === 'number' ? epText : typeof epText === 'string' ? Number(/(\d+)/.exec(epText)?.[1]) || undefined : undefined;
      out.set(key, { title, url: u, status: col.status, manhwa, episode });
    });
  }
  return [...out.values()];
}
