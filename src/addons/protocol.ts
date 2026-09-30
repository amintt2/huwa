// Stremio addon protocol (https://github.com/Stremio/stremio-addon-sdk/tree/master/docs): an
// addon is an HTTP server exposing `manifest.json` and `/{resource}/{type}/{id}[/{extra}].json`.
// Any Stremio-compatible addon URL works here, hosted by its author (Huwa ships none).
// Resources used: stream, catalog, meta, subtitles, addon_catalog.

export type Resource = 'stream' | 'catalog' | 'meta' | 'subtitles' | 'addon_catalog';

export type CatalogExtra = { name: string; isRequired?: boolean; options?: string[]; optionsLimit?: number };
export type ManifestCatalog = {
  type: string;
  id: string;
  name?: string;
  extra?: CatalogExtra[];
  /** Legacy (pre-`extra`) declarations, still used by some addons. */
  extraRequired?: string[];
  extraSupported?: string[];
  genres?: string[];
};

export type ManifestBehaviorHints = {
  adult?: boolean;
  p2p?: boolean;
  /** The addon has a `/configure` page. */
  configurable?: boolean;
  /** The addon does nothing until configured (its bare manifest has no useful resources). */
  configurationRequired?: boolean;
};

export type Manifest = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  logo?: string;
  background?: string;
  /** Strings ("stream") or objects ({ name, types, idPrefixes }). */
  resources: (string | { name: string; types?: string[]; idPrefixes?: string[] })[];
  types?: string[];
  idPrefixes?: string[];
  catalogs?: ManifestCatalog[];
  addonCatalogs?: ManifestCatalog[];
  behaviorHints?: ManifestBehaviorHints;
};

export type StreamBehaviorHints = {
  /** Needs a transcoding / proxy step on the web; native players usually play it directly. */
  notWebReady?: boolean;
  /** Same group = same release: used to keep the source for the next episode. */
  bingeGroup?: string;
  countryWhitelist?: string[];
  proxyHeaders?: { request?: Record<string, string>; response?: Record<string, string> };
  filename?: string;
  videoSize?: number;
  videoHash?: string;
};

export type StreamItem = {
  name?: string;
  title?: string;
  description?: string;
  /** Direct HTTP(S) / HLS URL: playable. */
  url?: string;
  /** Torrent: playable through a debrid service (or the future native engine). */
  infoHash?: string;
  fileIdx?: number;
  sources?: string[];
  /** YouTube video id: played in the embedded YouTube player. */
  ytId?: string;
  /** Web page opened in the browser (or a deep link to another app). */
  externalUrl?: string;
  /** Subtitles attached to this particular stream. */
  subtitles?: SubtitleItem[];
  behaviorHints?: StreamBehaviorHints;
};

export type AddonStream = StreamItem & { addonId: string; addonName: string };

export type MetaPreview = {
  id: string;
  type: string;
  name: string;
  poster?: string;
  posterShape?: 'square' | 'poster' | 'landscape';
  description?: string;
  releaseInfo?: string;
  imdbRating?: string;
  genres?: string[];
};

export type MetaVideo = {
  id: string;
  title?: string;
  name?: string;
  season?: number;
  episode?: number;
  released?: string;
  thumbnail?: string;
  overview?: string;
};

export type MetaDetail = MetaPreview & {
  background?: string;
  logo?: string;
  runtime?: string;
  year?: number | string;
  videos?: MetaVideo[];
};

export type SubtitleItem = { id?: string; url: string; lang: string };

/** Entry of an `addon_catalog` answer: another addon, described by its manifest. */
export type AddonDescriptor = { transportUrl: string; transportName?: string; manifest: Manifest };

/**
 * Any way people share a Stremio addon, down to its base URL (no trailing `/manifest.json`):
 * `stremio://host/…/manifest.json`, `https://host/…/manifest.json`, `https://host/…/configure`,
 * `https://web.stremio.com/#/addons?addon=<encoded manifest URL>` (also `app.strem.io`),
 * `huwa://addon?url=<encoded>` or a bare host.
 */
export function normalizeAddonUrl(input: string): string {
  let url = input.trim();
  // Share links that wrap the manifest URL in a query parameter.
  for (let i = 0; i < 3; i++) {
    const m = /[?&#](?:addon|url|manifest)=([^&#\s]+)/i.exec(url);
    if (!m || !/^(huwa:|https?:\/\/(web|app)\.strem(io\.com|\.io)|https?:\/\/www\.stremio\.com)/i.test(url)) break;
    url = safeDecode(m[1]).trim();
  }
  url = url.replace(/^stremio:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url
    .replace(/[?#].*$/, '')
    .replace(/\/manifest\.json$/i, '')
    .replace(/\/configure\/?$/i, '')
    .replace(/\/+$/, '');
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** `stremio://…` share link of an installed addon (what Stremio itself shows). */
export const stremioLink = (baseUrl: string) => `${baseUrl.replace(/^https?:\/\//, 'stremio://')}/manifest.json`;

/** One-click install link understood by Huwa. */
export const huwaInstallLink = (baseUrl: string) => `huwa://addon?url=${encodeURIComponent(`${baseUrl}/manifest.json`)}`;

export async function getJson<T>(url: string, timeoutMs = 8000): Promise<T> {
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

export function validManifest(m: unknown): m is Manifest {
  const x = m as Manifest | null;
  return !!x && typeof x.id === 'string' && typeof x.name === 'string' && Array.isArray(x.resources);
}

export async function fetchManifest(baseUrl: string): Promise<Manifest> {
  let m: unknown;
  try {
    m = await getJson<unknown>(`${baseUrl}/manifest.json`, 10000);
  } catch (e) {
    throw new Error(e instanceof Error && e.name === 'AbortError' ? 'Addon injoignable (délai dépassé)' : `Addon injoignable (${e instanceof Error ? e.message : e})`);
  }
  if (!validManifest(m)) throw new Error('Ce lien n’est pas un manifest d’addon Stremio');
  return m;
}

export const resourceNames = (m: Manifest) => m.resources.map((r) => (typeof r === 'string' ? r : r.name));

/** Needs its /configure page before it does anything. */
export const needsConfiguration = (m: Manifest) =>
  !!m.behaviorHints?.configurationRequired || (!!m.behaviorHints?.configurable && m.resources.length === 0);

export const configureUrl = (baseUrl: string) => `${baseUrl}/configure`;

/** Does the addon serve `resource` for this type and id (checks per-resource types / idPrefixes)? */
export function supports(m: Manifest, resource: Resource, type: string, id: string): boolean {
  const ok = (prefixes?: string[]) => !prefixes?.length || prefixes.some((p) => id.startsWith(p));
  return m.resources.some((r) => {
    if (typeof r === 'string') return r === resource && (!m.types || m.types.includes(type)) && ok(m.idPrefixes);
    return r.name === resource && (!(r.types ?? m.types) || (r.types ?? m.types)!.includes(type)) && ok(r.idPrefixes ?? m.idPrefixes);
  });
}

/** Declared id prefixes for a resource (empty = accepts any id). */
export function prefixesFor(m: Manifest, resource: Resource): string[] {
  for (const r of m.resources) {
    if (typeof r === 'string' && r === resource) return m.idPrefixes ?? [];
    if (typeof r !== 'string' && r.name === resource) return r.idPrefixes ?? m.idPrefixes ?? [];
  }
  return [];
}

export const hasResource = (m: Manifest, resource: Resource) => resourceNames(m).includes(resource);

/** @deprecated use `supports(m, 'stream', type, id)` */
export const supportsStream = (m: Manifest, type: string, id: string) => supports(m, 'stream', type, id);

export const extraPath = (extra?: Record<string, string | number | undefined>) => {
  const parts = Object.entries(extra ?? {}).filter(([, v]) => v !== '' && v != null);
  return parts.length ? `/${parts.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}` : '';
};

const MAGNET_HASH = /^magnet:\?.*xt=urn:btih:([a-f0-9]{40}|[a-z2-7]{32})/i;

/** Cleans one answer: `magnet:` URLs become torrents, junk entries are dropped. */
export function normalizeStream(s: StreamItem): StreamItem | null {
  if (!s || typeof s !== 'object') return null;
  let out = s;
  const magnet = s.url ? MAGNET_HASH.exec(s.url) : null;
  if (magnet) {
    const trackers = [...s.url!.matchAll(/[?&]tr=([^&]+)/g)].map((m) => `tracker:${safeDecode(m[1])}`);
    out = { ...s, url: undefined, infoHash: magnet[1].toLowerCase(), sources: s.sources ?? (trackers.length ? trackers : undefined) };
  }
  if (out.infoHash) out = { ...out, infoHash: out.infoHash.toLowerCase() };
  if (out.subtitles) out = { ...out, subtitles: out.subtitles.filter((x) => x?.url && /^https?:\/\//i.test(x.url)) };
  return out.url || out.infoHash || out.ytId || out.externalUrl ? out : null;
}

export async function fetchStreams(baseUrl: string, type: string, id: string): Promise<StreamItem[]> {
  const res = await getJson<{ streams?: StreamItem[] }>(`${baseUrl}/stream/${type}/${encodeURIComponent(id)}.json`, 12000);
  return (res.streams ?? []).map(normalizeStream).filter((s): s is StreamItem => !!s);
}

export type CatalogExtraValues = { search?: string; genre?: string; skip?: number };

export async function fetchCatalog(baseUrl: string, type: string, id: string, extra?: CatalogExtraValues): Promise<MetaPreview[]> {
  const res = await getJson<{ metas?: MetaPreview[] }>(
    `${baseUrl}/catalog/${type}/${encodeURIComponent(id)}${extraPath(extra)}.json`,
    12000,
  );
  return (res.metas ?? []).filter((m) => m?.id && m.name);
}

export async function fetchMeta(baseUrl: string, type: string, id: string): Promise<MetaDetail | null> {
  const res = await getJson<{ meta?: MetaDetail }>(`${baseUrl}/meta/${type}/${encodeURIComponent(id)}.json`, 10000);
  return res.meta ?? null;
}

export async function fetchSubtitles(baseUrl: string, type: string, id: string, extra?: Record<string, string>): Promise<SubtitleItem[]> {
  const res = await getJson<{ subtitles?: SubtitleItem[] }>(
    `${baseUrl}/subtitles/${type}/${encodeURIComponent(id)}${extraPath(extra)}.json`,
    10000,
  );
  return (res.subtitles ?? []).filter((s) => s?.url && /^https?:\/\//i.test(s.url));
}

/** `addon_catalog` resource: a list of other addons (e.g. Cinemeta's "community" list). */
export async function fetchAddonCatalog(baseUrl: string, type: string, id: string): Promise<AddonDescriptor[]> {
  const res = await getJson<{ addons?: AddonDescriptor[] }>(`${baseUrl}/addon_catalog/${type}/${encodeURIComponent(id)}.json`, 12000);
  return (res.addons ?? []).filter((a) => typeof a?.transportUrl === 'string' && /^https?:\/\//i.test(a.transportUrl) && validManifest(a.manifest));
}

const extraNames = (c: ManifestCatalog) => [...(c.extra ?? []).map((e) => e.name), ...(c.extraSupported ?? [])];
const requiredExtras = (c: ManifestCatalog) => [
  ...(c.extra ?? []).filter((e) => e.isRequired).map((e) => e.name),
  ...(c.extraRequired ?? []),
];

/** Catalogs browsable without typing anything (no required `search`; a required genre gets its first option). */
export const browsableCatalogs = (m: Manifest) =>
  (m.catalogs ?? []).filter((c) => requiredExtras(c).every((n) => n === 'genre' && catalogGenres(c).length > 0));

export const genreRequired = (c: ManifestCatalog) => requiredExtras(c).includes('genre');

/** Catalogs answering a text search (`search` extra, required or optional). */
export const searchableCatalogs = (m: Manifest) =>
  (m.catalogs ?? []).filter((c) => extraNames(c).includes('search') && requiredExtras(c).every((n) => n === 'search'));

export const catalogSupports = (c: ManifestCatalog, name: 'search' | 'genre' | 'skip') => extraNames(c).includes(name);

/** Genre options of a catalog (from `extra`, or the legacy `genres` list). */
export const catalogGenres = (c: ManifestCatalog) =>
  c.extra?.find((e) => e.name === 'genre')?.options ?? (catalogSupports(c, 'genre') ? c.genres ?? [] : []);

export const isPlayable = (s: StreamItem) => !!s.url && /^https?:\/\//i.test(s.url);
export const isTorrent = (s: StreamItem) => !s.url && !!s.infoHash;
export const isYouTube = (s: StreamItem) => !s.url && !s.infoHash && !!s.ytId;
/** `externalUrl` that opens outside Huwa (web page or another app; not Stremio's internal links). */
export const isExternal = (s: StreamItem) => !!s.externalUrl && !/^stremio:\/\/\//i.test(s.externalUrl);
