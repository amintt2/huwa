// Debrid providers: turn a torrent (infoHash) into a direct HTTPS link playable by expo-video.
// Every endpoint below was checked against the official docs (Sept 2026):
//   TorBox       https://api-docs.torbox.app (Postman collection) + https://api.torbox.app/openapi.json
//   AllDebrid    https://docs.alldebrid.com  (v4 / v4.1, Bearer auth, `agent` no longer required)
//   Premiumize   https://www.premiumize.me/api
//   Real-Debrid  https://api.real-debrid.com (instantAvailability is disabled: no cache check)
// Without a key each API answers "not authenticated" (verified with curl).

export type DebridId = 'torbox' | 'alldebrid' | 'premiumize' | 'realdebrid';

export type TorrentRef = {
  infoHash: string;
  fileIdx?: number;
  filename?: string;
  /** Extra trackers (`tracker:udp://…`) from the addon. */
  sources?: string[];
  /** Episode hint, used to pick the right file in a season pack. */
  episode?: number;
};

export type DebridFile = { id: number; name: string; size: number };

export type DebridProvider = {
  id: DebridId;
  name: string;
  /** Where the user finds their API key. */
  keyUrl: string;
  /** Instant availability check, when the provider still offers one. */
  checkCached?: (key: string, hashes: string[]) => Promise<Record<string, boolean>>;
  resolve: (key: string, t: TorrentRef, signal?: AbortSignal) => Promise<string>;
  /** Cheap authenticated call to validate a key. */
  validate: (key: string) => Promise<void>;
};

export class DebridError extends Error {
  readonly code?: 'not_cached' | 'auth' | 'timeout' | 'no_file';
  constructor(message: string, code?: 'not_cached' | 'auth' | 'timeout' | 'no_file') {
    super(message);
    this.code = code;
  }
}

// ---------- helpers ----------

const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|flv)$/i;
const base = (p: string) => p.split('/').pop()!.toLowerCase();

export function magnetOf(t: TorrentRef) {
  const tr = (t.sources ?? [])
    .filter((s) => s.startsWith('tracker:'))
    .slice(0, 10)
    .map((s) => `&tr=${encodeURIComponent(s.slice(8))}`)
    .join('');
  return `magnet:?xt=urn:btih:${t.infoHash.toLowerCase()}${tr}`;
}

const epPattern = (n: number) => new RegExp(`(?:e|ep|episode|\\s|-|_|\\[)0*${n}(?:v\\d)?(?:\\D|$)`, 'i');

/**
 * Picks the file to play: exact filename from the addon → torrent file index (`orderIndex`) →
 * episode number in the name → largest video.
 */
export function pickFile<F extends { name: string; size: number }>(files: F[], t: TorrentRef, orderIndex?: (f: F, i: number) => number): F | undefined {
  if (!files.length) return undefined;
  if (t.filename) {
    const want = base(t.filename);
    const hit = files.find((f) => base(f.name) === want);
    if (hit) return hit;
  }
  if (t.fileIdx != null && orderIndex) {
    const hit = files.find((f, i) => orderIndex(f, i) === t.fileIdx);
    if (hit && VIDEO.test(hit.name)) return hit;
  }
  const videos = files.filter((f) => VIDEO.test(f.name));
  const pool = videos.length ? videos : files;
  if (t.episode != null && pool.length > 1) {
    const hit = pool.find((f) => epPattern(t.episode!).test(base(f.name)));
    if (hit) return hit;
  }
  return [...pool].sort((a, b) => b.size - a.size)[0];
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(id);
      reject(new DebridError('Annulé', 'timeout'));
    });
  });

async function http<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 15000);
  init.signal?.addEventListener('abort', () => ctrl.abort());
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { Accept: 'application/json', ...init.headers } });
    if (res.status === 401 || res.status === 403) throw new DebridError('Clé API refusée', 'auth');
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      throw new DebridError(`Réponse invalide (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const b = body as { error?: string | { message?: string }; detail?: string } | undefined;
      const msg = typeof b?.error === 'string' ? b.error : b?.error?.message ?? b?.detail ?? `HTTP ${res.status}`;
      throw new DebridError(msg);
    }
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

const form = (data: Record<string, string | string[]>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) (Array.isArray(v) ? v : [v]).forEach((x) => p.append(k, x));
  return p.toString();
};
const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

// ---------- TorBox ----------
// POST /v1/api/torrents/createtorrent (multipart: magnet, add_only_if_cached) → data.torrent_id
// GET  /v1/api/torrents/mylist?id=…&bypass_cache=true → data.files[] {id, name, short_name, size}
// GET  /v1/api/torrents/requestdl?token=…&torrent_id=…&file_id=… → data (URL)
// GET  /v1/api/torrents/checkcached?hash=a,b&format=object → data { hash: {...} }
type TorBox<T> = { success: boolean; error: string | null; detail: string; data: T };
const TB = 'https://api.torbox.app/v1/api';

const torbox: DebridProvider = {
  id: 'torbox',
  name: 'TorBox',
  keyUrl: 'https://torbox.app/settings',
  async validate(key) {
    const r = await http<TorBox<unknown>>(`${TB}/user/me`, { headers: bearer(key) });
    if (!r.success) throw new DebridError(r.detail || 'Clé refusée', 'auth');
  },
  async checkCached(key, hashes) {
    const r = await http<TorBox<Record<string, unknown> | null>>(
      `${TB}/torrents/checkcached?hash=${hashes.map((h) => h.toLowerCase()).join(',')}&format=object`,
      { headers: bearer(key) },
    );
    const data = r.data ?? {};
    return Object.fromEntries(hashes.map((h) => [h.toLowerCase(), !!data[h.toLowerCase()]]));
  },
  async resolve(key, t, signal) {
    const body = new FormData();
    body.append('magnet', magnetOf(t));
    body.append('add_only_if_cached', 'true');
    const created = await http<TorBox<{ torrent_id: number } | null>>(`${TB}/torrents/createtorrent`, {
      method: 'POST', headers: bearer(key), body, signal,
    });
    if (!created.success || !created.data) throw new DebridError(created.detail || 'Pas en cache sur TorBox', 'not_cached');
    const id = created.data.torrent_id;
    for (let i = 0; i < 6; i++) {
      const info = await http<TorBox<{ files?: { id: number; name: string; short_name?: string; size: number }[]; download_present?: boolean } | null>>(
        `${TB}/torrents/mylist?id=${id}&bypass_cache=true`, { headers: bearer(key), signal },
      );
      const files = info.data?.files ?? [];
      if (files.length && info.data?.download_present !== false) {
        const f = pickFile(files, t, (_f, idx) => idx);
        if (!f) throw new DebridError('Aucun fichier vidéo', 'no_file');
        const dl = await http<TorBox<string | null>>(
          `${TB}/torrents/requestdl?token=${encodeURIComponent(key)}&torrent_id=${id}&file_id=${f.id}`, { signal },
        );
        if (!dl.success || !dl.data) throw new DebridError(dl.detail || 'Lien indisponible');
        return dl.data;
      }
      await sleep(1500, signal);
    }
    throw new DebridError('Pas en cache sur TorBox', 'not_cached');
  },
};

// ---------- AllDebrid ----------
// POST /v4/magnet/upload (magnets[]) → data.magnets[] {id, ready}
// POST /v4.1/magnet/status (id) → data.magnets[] {statusCode: 4 = Ready}
// POST /v4/magnet/files (id[]) → data.magnets[].files: tree {n, s, l, e}
// POST /v4/link/unlock (link) → data.link | data.delayed
// Instant availability endpoint was removed by AllDebrid: `ready` after upload plays that role.
type AD<T> = { status: 'success' | 'error'; data?: T; error?: { code: string; message: string } };
const AD_API = 'https://api.alldebrid.com';
type ADNode = { n: string; s?: number; l?: string; e?: ADNode[] };

async function ad<T>(key: string, path: string, data: Record<string, string | string[]>, signal?: AbortSignal) {
  const r = await http<AD<T>>(`${AD_API}${path}`, { method: 'POST', headers: { ...bearer(key), ...FORM }, body: form(data), signal });
  if (r.status !== 'success' || !r.data) {
    const code = r.error?.code ?? '';
    throw new DebridError(r.error?.message ?? 'Erreur AllDebrid', /AUTH|APIKEY/.test(code) ? 'auth' : undefined);
  }
  return r.data;
}

const flatten = (nodes: ADNode[], prefix = ''): { name: string; size: number; link: string }[] =>
  nodes.flatMap((n) =>
    n.e ? flatten(n.e, `${prefix}${n.n}/`) : n.l ? [{ name: `${prefix}${n.n}`, size: n.s ?? 0, link: n.l }] : [],
  );

const alldebrid: DebridProvider = {
  id: 'alldebrid',
  name: 'AllDebrid',
  keyUrl: 'https://alldebrid.com/apikeys/',
  async validate(key) {
    const r = await http<AD<unknown>>(`${AD_API}/v4/user`, { headers: bearer(key) });
    if (r.status !== 'success') throw new DebridError(r.error?.message ?? 'Clé refusée', 'auth');
  },
  async resolve(key, t, signal) {
    const up = await ad<{ magnets: { id?: number; ready?: boolean; error?: { message: string } }[] }>(
      key, '/v4/magnet/upload', { 'magnets[]': [magnetOf(t)] }, signal,
    );
    const m = up.magnets[0];
    if (!m?.id) throw new DebridError(m?.error?.message ?? 'Magnet refusé');
    let ready = !!m.ready;
    for (let i = 0; !ready && i < 4; i++) {
      await sleep(1500, signal);
      const st = await ad<{ magnets: { statusCode: number }[] | { statusCode: number } }>(key, '/v4.1/magnet/status', { id: String(m.id) }, signal);
      const s = Array.isArray(st.magnets) ? st.magnets[0] : st.magnets;
      ready = s?.statusCode === 4;
      if (s && s.statusCode > 4) throw new DebridError('Magnet en erreur sur AllDebrid');
    }
    if (!ready) throw new DebridError('Pas en cache sur AllDebrid', 'not_cached');
    const fl = await ad<{ magnets: { files?: ADNode[] }[] }>(key, '/v4/magnet/files', { 'id[]': [String(m.id)] }, signal);
    const files = flatten(fl.magnets[0]?.files ?? []);
    const f = pickFile(files, t);
    if (!f) throw new DebridError('Aucun fichier vidéo', 'no_file');
    const un = await ad<{ link?: string; delayed?: number }>(key, '/v4/link/unlock', { link: f.link }, signal);
    if (!un.link) throw new DebridError('Lien différé par AllDebrid, réessaie plus tard');
    return un.link;
  },
};

// ---------- Premiumize ----------
// GET  /api/cache/check?items[]=… → response: boolean[]
// POST /api/transfer/directdl (src=magnet) → content[] {path, size, link}
type PM = { status: 'success' | 'error'; message?: string };
const PM_API = 'https://www.premiumize.me/api';

const premiumize: DebridProvider = {
  id: 'premiumize',
  name: 'Premiumize',
  keyUrl: 'https://www.premiumize.me/account',
  async validate(key) {
    const r = await http<PM>(`${PM_API}/account/info`, { headers: bearer(key) });
    if (r.status !== 'success') throw new DebridError(r.message ?? 'Clé refusée', 'auth');
  },
  async checkCached(key, hashes) {
    const q = hashes.map((h) => `items[]=${h.toLowerCase()}`).join('&');
    const r = await http<PM & { response?: boolean[] }>(`${PM_API}/cache/check?${q}`, { headers: bearer(key) });
    if (r.status !== 'success') throw new DebridError(r.message ?? 'Erreur Premiumize');
    return Object.fromEntries(hashes.map((h, i) => [h.toLowerCase(), !!r.response?.[i]]));
  },
  async resolve(key, t, signal) {
    const r = await http<PM & { content?: { path: string; size: number; link?: string }[] }>(`${PM_API}/transfer/directdl`, {
      method: 'POST', headers: { ...bearer(key), ...FORM }, body: form({ src: magnetOf(t) }), signal, timeoutMs: 25000,
    });
    if (r.status !== 'success') throw new DebridError(r.message ?? 'Pas en cache sur Premiumize', 'not_cached');
    const files = (r.content ?? []).filter((c) => c.link).map((c) => ({ name: c.path, size: Number(c.size) || 0, link: c.link! }));
    const f = pickFile(files, t);
    if (!f) throw new DebridError('Pas en cache sur Premiumize', 'not_cached');
    return f.link;
  },
};

// ---------- Real-Debrid ----------
// POST /torrents/addMagnet (magnet) → {id}
// GET  /torrents/info/{id} → {status, files[] {id (1-based), path, bytes, selected}, links[]}
// POST /torrents/selectFiles/{id} (files=ids) → 204
// POST /unrestrict/link (link) → {download}
const RD = 'https://api.real-debrid.com/rest/1.0';
type RDInfo = { status: string; files?: { id: number; path: string; bytes: number; selected: number }[]; links?: string[] };

const realdebrid: DebridProvider = {
  id: 'realdebrid',
  name: 'Real-Debrid',
  keyUrl: 'https://real-debrid.com/apitoken',
  async validate(key) {
    await http(`${RD}/user`, { headers: bearer(key) });
  },
  async resolve(key, t, signal) {
    const add = await http<{ id: string }>(`${RD}/torrents/addMagnet`, {
      method: 'POST', headers: { ...bearer(key), ...FORM }, body: form({ magnet: magnetOf(t) }), signal,
    });
    const info = () => http<RDInfo>(`${RD}/torrents/info/${add.id}`, { headers: bearer(key), signal });
    let cur = await info();
    for (let i = 0; cur.status === 'magnet_conversion' && i < 5; i++) {
      await sleep(1000, signal);
      cur = await info();
    }
    const files = (cur.files ?? []).map((f) => ({ ...f, name: f.path, size: f.bytes }));
    const f = pickFile(files, t, (x) => x.id - 1);
    if (!f) throw new DebridError('Aucun fichier vidéo', 'no_file');
    if (cur.status === 'waiting_files_selection') {
      await http(`${RD}/torrents/selectFiles/${add.id}`, {
        method: 'POST', headers: { ...bearer(key), ...FORM }, body: form({ files: String(f.id) }), signal,
      });
    }
    for (let i = 0; i < 4; i++) {
      cur = await info();
      if (cur.status === 'downloaded') break;
      if (['magnet_error', 'error', 'virus', 'dead'].includes(cur.status)) throw new DebridError('Torrent en erreur sur Real-Debrid');
      await sleep(1500, signal);
    }
    if (cur.status !== 'downloaded') throw new DebridError('Pas en cache sur Real-Debrid', 'not_cached');
    // `links` lists one hoster link per selected file, in file order.
    const selected = (cur.files ?? []).filter((x) => x.selected === 1);
    const link = cur.links?.[Math.max(0, selected.findIndex((x) => x.id === f.id))];
    if (!link) throw new DebridError('Lien indisponible');
    const un = await http<{ download: string }>(`${RD}/unrestrict/link`, {
      method: 'POST', headers: { ...bearer(key), ...FORM }, body: form({ link }), signal,
    });
    return un.download;
  },
};

export const PROVIDERS: Record<DebridId, DebridProvider> = { torbox, alldebrid, premiumize, realdebrid };
export const PROVIDER_LIST = [torbox, alldebrid, premiumize, realdebrid];
