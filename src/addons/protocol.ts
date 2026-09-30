// Stremio addon protocol (https://github.com/Stremio/stremio-addon-sdk): an addon is an HTTP
// server exposing `manifest.json` and `/{resource}/{type}/{id}[/{extra}].json`. Any
// Stremio-compatible addon URL works here. Resources used: stream, catalog, meta, subtitles.

export type Resource = 'stream' | 'catalog' | 'meta' | 'subtitles';

export type CatalogExtra = { name: string; isRequired?: boolean; options?: string[] };
export type ManifestCatalog = { type: string; id: string; name?: string; extra?: CatalogExtra[]; extraRequired?: string[] };

export type Manifest = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  logo?: string;
  /** Strings ("stream") or objects ({ name, types, idPrefixes }). */
  resources: (string | { name: string; types?: string[]; idPrefixes?: string[] })[];
  types?: string[];
  idPrefixes?: string[];
  catalogs?: ManifestCatalog[];
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
  ytId?: string;
  externalUrl?: string;
  behaviorHints?: { proxyHeaders?: { request?: Record<string, string> }; filename?: string; bingeGroup?: string };
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

/** Accepts `stremio://host/manifest.json`, `https://host/…/manifest.json` or a bare base URL. */
export function normalizeAddonUrl(input: string): string {
  let url = input.trim().replace(/^stremio:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/manifest\.json.*$/i, '').replace(/\/+$/, '');
}

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

export async function fetchManifest(baseUrl: string): Promise<Manifest> {
  const m = await getJson<Manifest>(`${baseUrl}/manifest.json`);
  if (!m?.id || !m.name || !Array.isArray(m.resources)) throw new Error('Manifest invalide');
  return m;
}

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

export const hasResource = (m: Manifest, resource: Resource) =>
  m.resources.some((r) => (typeof r === 'string' ? r : r.name) === resource);

/** @deprecated use `supports(m, 'stream', type, id)` */
export const supportsStream = (m: Manifest, type: string, id: string) => supports(m, 'stream', type, id);

const extraPath = (extra?: Record<string, string>) => {
  const parts = Object.entries(extra ?? {}).filter(([, v]) => v !== '');
  return parts.length ? `/${parts.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : '';
};

export async function fetchStreams(baseUrl: string, type: string, id: string): Promise<StreamItem[]> {
  const res = await getJson<{ streams?: StreamItem[] }>(`${baseUrl}/stream/${type}/${encodeURIComponent(id)}.json`, 10000);
  return res.streams ?? [];
}

export async function fetchCatalog(baseUrl: string, type: string, id: string, extra?: Record<string, string>): Promise<MetaPreview[]> {
  const res = await getJson<{ metas?: MetaPreview[] }>(
    `${baseUrl}/catalog/${type}/${encodeURIComponent(id)}${extraPath(extra)}.json`,
    10000,
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

/** Catalogs browsable without user input (no required extra such as `search`). */
export const browsableCatalogs = (m: Manifest) =>
  (m.catalogs ?? []).filter(
    (c) => !c.extra?.some((e) => e.isRequired) && !c.extraRequired?.length,
  );

export const isPlayable = (s: StreamItem) => !!s.url && /^https?:\/\//i.test(s.url);
export const isTorrent = (s: StreamItem) => !s.url && !!s.infoHash;
