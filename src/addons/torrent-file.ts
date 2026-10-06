// `.torrent` links in addon answers (`url: "https://indexer/…/file.torrent"`, Jackett/Prowlarr-style
// addons): the player cannot open a .torrent, the torrent engine takes an info hash. The file is
// read once here and the stream becomes an ordinary torrent stream (`infoHash` + its trackers as
// `sources`); the engine then fetches the metadata from the swarm, as for a magnet link.
import { sha1 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { StreamItem } from './protocol';

export type TorrentFileInfo = {
  infoHash: string;
  name?: string;
  trackers: string[];
  files: { path: string; length: number }[];
};

/** `url` whose path (or a query parameter) names a `.torrent` file. */
export function isTorrentFileUrl(url: string | undefined): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  let path = url.split(/[?#]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep raw
  }
  return /\.torrent$/i.test(path) || /[?&][^=]+=[^&]*\.torrent(&|$)/i.test(url);
}

// ---------- bencode (just enough: the `info` dictionary's exact bytes for the hash) ----------

type BValue = number | Uint8Array | BValue[] | BDict;
type BDict = { value: Map<string, BValue>; spans: Map<string, [number, number]> };

const latin1 = (b: Uint8Array) => String.fromCharCode(...b);
const utf8 = (b: Uint8Array) => {
  try {
    return new TextDecoder('utf-8').decode(b);
  } catch {
    return latin1(b);
  }
};

class Reader {
  at = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }

  value(depth = 0): BValue {
    if (depth > 64) throw new Error('bencode: too deep');
    const c = this.b[this.at];
    if (c === 0x69 /* i */) {
      const end = this.b.indexOf(0x65, this.at);
      if (end < 0) throw new Error('bencode: int');
      const n = Number(latin1(this.b.subarray(this.at + 1, end)));
      this.at = end + 1;
      return n;
    }
    if (c === 0x6c /* l */) {
      this.at++;
      const out: BValue[] = [];
      while (this.b[this.at] !== 0x65) {
        if (this.at >= this.b.length) throw new Error('bencode: list');
        out.push(this.value(depth + 1));
      }
      this.at++;
      return out;
    }
    if (c === 0x64 /* d */) {
      this.at++;
      const value = new Map<string, BValue>();
      const spans = new Map<string, [number, number]>();
      while (this.b[this.at] !== 0x65) {
        if (this.at >= this.b.length) throw new Error('bencode: dict');
        const key = latin1(this.string());
        const start = this.at;
        value.set(key, this.value(depth + 1));
        spans.set(key, [start, this.at]);
      }
      this.at++;
      return { value, spans };
    }
    return this.string();
  }

  string(): Uint8Array {
    const colon = this.b.indexOf(0x3a, this.at);
    const len = Number(latin1(this.b.subarray(this.at, colon)));
    if (colon < 0 || !Number.isInteger(len) || len < 0 || colon + 1 + len > this.b.length) throw new Error('bencode: string');
    const s = this.b.subarray(colon + 1, colon + 1 + len);
    this.at = colon + 1 + len;
    return s;
  }
}

const isDict = (v: BValue | undefined): v is BDict => !!v && typeof v === 'object' && 'spans' in v;
const str = (v: BValue | undefined) => (v instanceof Uint8Array ? utf8(v) : undefined);

/** Info hash, name, trackers and files of a `.torrent` file. Throws on anything else. */
export function parseTorrentFile(bytes: Uint8Array): TorrentFileInfo {
  if (bytes[0] !== 0x64) throw new Error('not a torrent file');
  const root = new Reader(bytes).value();
  if (!isDict(root)) throw new Error('not a torrent file');
  const info = root.value.get('info');
  const span = root.spans.get('info');
  if (!isDict(info) || !span) throw new Error('torrent without info');
  const trackers: string[] = [];
  const add = (v: BValue | undefined) => {
    const t = str(v);
    if (t && /^(udp|https?|wss?):\/\//i.test(t) && !trackers.includes(t)) trackers.push(t);
  };
  add(root.value.get('announce'));
  const tiers = root.value.get('announce-list');
  if (Array.isArray(tiers)) for (const tier of tiers) if (Array.isArray(tier)) tier.forEach(add);
  const name = str(info.value.get('name.utf-8')) ?? str(info.value.get('name'));
  const files: TorrentFileInfo['files'] = [];
  const list = info.value.get('files');
  if (Array.isArray(list)) {
    for (const f of list) {
      if (!isDict(f)) continue;
      const parts = f.value.get('path.utf-8') ?? f.value.get('path');
      const path = Array.isArray(parts) ? parts.map((p) => str(p) ?? '').join('/') : '';
      files.push({ path: name ? `${name}/${path}` : path, length: Number(f.value.get('length')) || 0 });
    }
  } else if (name) files.push({ path: name, length: Number(info.value.get('length')) || 0 });
  return { infoHash: bytesToHex(sha1(bytes.subarray(span[0], span[1]))), name, trackers, files };
}

/** The torrent stream a `.torrent` link stands for (title, fileIdx, hints… kept). */
export function torrentStreamFrom(s: StreamItem, t: TorrentFileInfo): StreamItem {
  const sources = [...(s.sources ?? []), ...t.trackers.map((x) => `tracker:${x}`)];
  return { ...s, url: undefined, infoHash: t.infoHash, sources: sources.length ? [...new Set(sources)] : undefined };
}

const MAX_BYTES = 8 * 1024 * 1024;

/** Downloads and parses a `.torrent` link; null when it cannot be read in time. */
export async function fetchTorrentFile(url: string, timeoutMs = 6000, f: typeof fetch = fetch): Promise<TorrentFileInfo | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length'));
    if (len > MAX_BYTES) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length <= MAX_BYTES ? parseTorrentFile(bytes) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** At most this many `.torrent` links read per addon answer (an indexer can list hundreds). */
const MAX_PER_ANSWER = 12;

/**
 * Replaces the `.torrent` links of an answer by torrent streams. Links that cannot be read (or
 * past `MAX_PER_ANSWER`) are dropped: the player could not open them anyway.
 */
export async function resolveTorrentFileStreams(streams: StreamItem[], f: typeof fetch = fetch): Promise<StreamItem[]> {
  const todo = streams.filter((s) => isTorrentFileUrl(s.url)).slice(0, MAX_PER_ANSWER);
  if (!todo.length) return streams;
  const parsed = new Map<StreamItem, TorrentFileInfo | null>();
  await Promise.all(todo.map(async (s) => parsed.set(s, await fetchTorrentFile(s.url!, 6000, f))));
  const out: StreamItem[] = [];
  for (const s of streams) {
    if (!isTorrentFileUrl(s.url)) out.push(s);
    else {
      const t = parsed.get(s);
      if (t) out.push(torrentStreamFrom(s, t));
    }
  }
  return out;
}
