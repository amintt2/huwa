// Stremio addon protocol (https://github.com/Stremio/stremio-addon-sdk): an addon is an HTTP
// server exposing `manifest.json` and `/{resource}/{type}/{id}.json`. Any Stremio-compatible
// addon URL works here.

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
};

export type StreamItem = {
  name?: string;
  title?: string;
  description?: string;
  /** Direct HTTP(S) / HLS URL: playable. */
  url?: string;
  /** Torrent: needs a torrent engine, not playable in this app yet. */
  infoHash?: string;
  ytId?: string;
  externalUrl?: string;
  behaviorHints?: { proxyHeaders?: { request?: Record<string, string> }; filename?: string };
};

export type AddonStream = StreamItem & { addonId: string; addonName: string };

/** Accepts `stremio://host/manifest.json`, `https://host/…/manifest.json` or a bare base URL. */
export function normalizeAddonUrl(input: string): string {
  let url = input.trim().replace(/^stremio:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/manifest\.json.*$/i, '').replace(/\/+$/, '');
}

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T> {
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

export function supportsStream(m: Manifest, type: string, id: string): boolean {
  const ok = (prefixes?: string[]) => !prefixes?.length || prefixes.some((p) => id.startsWith(p));
  return m.resources.some((r) => {
    if (typeof r === 'string') return r === 'stream' && (!m.types || m.types.includes(type)) && ok(m.idPrefixes);
    return r.name === 'stream' && (!r.types || r.types.includes(type)) && ok(r.idPrefixes ?? m.idPrefixes);
  });
}

export async function fetchStreams(baseUrl: string, type: string, id: string): Promise<StreamItem[]> {
  const res = await getJson<{ streams?: StreamItem[] }>(
    `${baseUrl}/stream/${type}/${encodeURIComponent(id)}.json`,
    10000,
  );
  return res.streams ?? [];
}

export const isPlayable = (s: StreamItem) => !!s.url && /^https?:\/\//i.test(s.url);
