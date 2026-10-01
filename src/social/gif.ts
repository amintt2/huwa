// GIFs in comments (pure, unit-tested). A GIF is an https link to an allowlisted GIF CDN, carried
// in the comment text (no new P2P field: older apps simply show the link). Anything else is a
// plain link. The picker (GIPHY API, optional key) only ever returns allowlisted URLs.

export const MAX_GIF_URL = 300;

/** CDN hosts that serve the GIF files themselves (not web pages). */
const GIF_HOSTS: RegExp[] = [
  /^media\d?\.giphy\.com$/, // media.giphy.com, media0…media4.giphy.com
  /^i\.giphy\.com$/,
  /^media\.tenor\.com$/,
  /^c\.tenor\.com$/, // older Tenor links
  /^static\.klipy\.com$/,
];
export const GIF_HOST_LABELS = ['GIPHY', 'Tenor', 'Klipy'];

const URL_RE = /^https:\/\/([a-z0-9.-]+)(\/[^\s?#]*)(\?[^\s#]*)?$/i;

/** https, allowlisted host, an image path, bounded length, no credentials or port. */
export function isAllowedGifUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length > MAX_GIF_URL) return false;
  const m = URL_RE.exec(url);
  if (!m) return false;
  const host = m[1].toLowerCase();
  if (!GIF_HOSTS.some((re) => re.test(host))) return false;
  const path = m[2];
  if (path.includes('..') || path.length < 2) return false;
  return /\.(gif|webp)$/i.test(path);
}

/**
 * What the user pasted → a GIF URL, or a reason it is not one. GIPHY page links
 * (giphy.com/gifs/slug-ID) are turned into their media URL; query strings are dropped.
 */
export function normalizeGifLink(input: string): { url: string } | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: 'Colle un lien GIPHY ou Tenor.' };
  if (!/^https?:\/\//i.test(raw)) return { error: 'Ce n’est pas un lien.' };
  const page = /^https?:\/\/(?:www\.)?giphy\.com\/(?:gifs|stickers)\/(?:[\w-]*-)?([A-Za-z0-9]{6,40})\/?(?:[?#].*)?$/i.exec(raw);
  if (page) return { url: `https://i.giphy.com/${page[1]}.gif` };
  const media = /^https?:\/\/(?:www\.)?giphy\.com\/media\/([A-Za-z0-9]{6,40})\//i.exec(raw);
  if (media) return { url: `https://i.giphy.com/${media[1]}.gif` };
  if (/^https?:\/\/(?:www\.)?tenor\.com\/view\//i.test(raw)) {
    return { error: 'Lien de page Tenor : ouvre le GIF, puis « Copier l’adresse de l’image » (media.tenor.com).' };
  }
  const url = raw.replace(/^http:\/\//i, 'https://').replace(/[?#].*$/, '');
  if (isAllowedGifUrl(url)) return { url };
  return { error: 'Seuls les GIFs de GIPHY, Tenor ou Klipy sont acceptés.' };
}

/**
 * The first allowlisted GIF URL of a text, and the text without it (the URL is shown as the GIF,
 * not as a link). Only a URL standing on its own (spaces or line breaks around it) counts.
 */
export function extractGif(text: string): { gif?: string; text: string } {
  const re = /(^|\s)(https:\/\/\S+)(?=\s|$)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const url = m[2];
    if (!isAllowedGifUrl(url)) continue;
    const start = m.index + m[1].length;
    const rest = (text.slice(0, start) + text.slice(start + url.length)).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { gif: url, text: rest };
  }
  return { text };
}

/** Text sent for a comment with an attached GIF (the URL on its own last line). */
export function attachGif(text: string, gif: string | undefined): string {
  const body = text.trim();
  if (!gif) return body;
  return body ? `${body}\n${gif}` : gif;
}

// ---------- GIPHY search (only when a key is configured) ----------

export type GifResult = { id: string; url: string; preview: string; width: number; height: number; title: string };

export const GIF_RATING = 'pg-13';

export function giphyEndpoint(key: string, query: string, limit = 24): string {
  const base = 'https://api.giphy.com/v1/gifs/';
  const common = `api_key=${encodeURIComponent(key)}&limit=${limit}&rating=${GIF_RATING}`;
  const q = query.trim().slice(0, 50);
  return q ? `${base}search?${common}&q=${encodeURIComponent(q)}&lang=fr` : `${base}trending?${common}`;
}

const ALLOWED_RATINGS = new Set(['g', 'pg', 'pg-13']);
type GiphyImage = { url?: unknown; width?: unknown; height?: unknown };
const dropQuery = (u: unknown) => (typeof u === 'string' ? u.replace(/[?#].*$/, '') : '');

/** GIPHY API JSON → results, keeping only allowlisted, well-formed, rated ≤ pg-13 GIFs. */
export function parseGiphyResponse(json: unknown): GifResult[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: GifResult[] = [];
  for (const item of data.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue;
    const it = item as { id?: unknown; title?: unknown; rating?: unknown; images?: Record<string, GiphyImage> };
    if (typeof it.id !== 'string' || !ALLOWED_RATINGS.has(String(it.rating ?? 'g'))) continue;
    const full = it.images?.fixed_height ?? it.images?.downsized;
    const small = it.images?.fixed_width_downsampled ?? it.images?.fixed_width ?? full;
    const url = dropQuery(full?.url);
    const preview = dropQuery(small?.url);
    if (!isAllowedGifUrl(url) || !isAllowedGifUrl(preview)) continue;
    const width = Number(full?.width) || 200;
    const height = Number(full?.height) || 200;
    out.push({ id: it.id, url, preview, width, height, title: typeof it.title === 'string' ? it.title.slice(0, 80) : '' });
  }
  return out;
}
