// Header sniffs: the real audio tracks of a candidate before it is started (see ./track-info.ts).
//   - HTTP: the source race already reads the first 96–160 KiB of each link; that body is parsed
//     here (`inspectRaceBody`, no extra request). A follow-up Range read is made only when the
//     Tracks element / moov lies further (`need`), in dub mode.
//   - Torrent (on-device engine): the engine pre-warms the file (first pieces + container index,
//     never the focus) and its loopback URL is read with a Range request, the first 256 KiB.
//     Bounded: two torrents at a time, an 8 s budget each, results cached per infoHash + file.
// Every read is a `RangeReader` (XMLHttpRequest on device, injected in tests).
import { readHead } from '@/components/player/engines/probe';
import { sniffMore, sniffTracks, TRACK_HEAD_BYTES, type TrackList, type TrackSniff } from '@/components/player/engines/tracks';
import { getSettings } from '@/settings/settings';

import { httpKey, knownOf, setFailed, setPending, setTracks, trackEntry } from './track-info';

export type RangeReader = (url: string, headers: Record<string, string> | undefined, start: number, end: number, timeoutMs: number) => Promise<Uint8Array | null>;

const xhrReader: RangeReader = async (url, headers, start, end, timeoutMs) => {
  const h = await readHead(url, headers, start, end, timeoutMs);
  return h.status === 206 && h.bytes?.length ? h.bytes : null;
};

/** HTTP sniff budget (head + follow-up). */
export const HTTP_SNIFF_MS = 4000;
/** Torrent sniff budget: pre-warm start + the head read through the engine. */
export const TORRENT_SNIFF_MS = 8000;
const MAX_TORRENT_SNIFFS = 2;

/** Reads the head, then the range the head says is still needed. */
export async function readTracks(url: string, headers: Record<string, string> | undefined, reader: RangeReader, timeoutMs: number, head?: Uint8Array): Promise<TrackList | null> {
  const t0 = Date.now();
  const first = head ?? (await reader(url, headers, 0, TRACK_HEAD_BYTES - 1, timeoutMs));
  if (!first?.length) return null;
  const r: TrackSniff = sniffTracks(first);
  if (!r.need) return r.list;
  const left = Math.max(1000, timeoutMs - (Date.now() - t0));
  const more = await reader(url, headers, r.need.start, r.need.end, left);
  if (!more?.length) return r.list;
  const m = sniffMore(first, more, r.need.start);
  return m.list ?? r.list;
}

/** Sniffs an HTTP link once (deduplicated, cached per URL). */
export async function sniffHttp(url: string, headers?: Record<string, string>, family?: string | null, reader: RangeReader = xhrReader): Promise<void> {
  const key = httpKey(url);
  if (trackEntry(key)) return;
  setPending(key);
  try {
    const list = await readTracks(url, headers, reader, HTTP_SNIFF_MS);
    if (list && list.tracks.some((t) => t.kind === 'audio')) setTracks(key, knownOf(list), family);
    else setFailed(key);
  } catch {
    setFailed(key);
  }
}

/**
 * The race's own probe body of a link (first bytes of the file): its tracks, for free. When the
 * tracks are further in the file, a follow-up read is made in dub mode only.
 */
export function inspectRaceBody(url: string, headers: Record<string, string> | undefined, body: Uint8Array, reader: RangeReader = xhrReader) {
  const key = httpKey(url);
  if (trackEntry(key)?.state === 'done') return;
  let r: TrackSniff;
  try {
    r = sniffTracks(body);
  } catch {
    return;
  }
  if (r.list && (r.list.complete || !r.need)) {
    if (r.list.tracks.some((t) => t.kind === 'audio')) setTracks(key, knownOf(r.list));
    return;
  }
  if (!r.need) {
    // Not a container we read (HLS playlist, TS…): nothing to learn from the header.
    if (!r.list) setFailed(key);
    return;
  }
  if (getSettings().watchMode !== 'dub' || trackEntry(key)) return;
  setPending(key);
  readTracks(url, headers, reader, HTTP_SNIFF_MS, body)
    .then((list) => (list && list.tracks.some((t) => t.kind === 'audio') ? setTracks(key, knownOf(list)) : setFailed(key)))
    .catch(() => setFailed(key));
}

// ---------- torrents ----------

export type TorrentTarget = { infoHash: string; fileIdx?: number | null; sources?: string[]; name?: string };
/** Opens a torrent file in the engine without making it the focus; resolves its loopback URL. */
export type TorrentOpener = (t: TorrentTarget) => Promise<string | null>;

let opener: TorrentOpener | null = null;
/** Registered by the app (src/addons/use-source.ts): the engine's pre-warm. */
export function setTorrentOpener(o: TorrentOpener | null) {
  opener = o;
}

let running = 0;
const queue: (() => void)[] = [];
const next = () => {
  running--;
  queue.shift()?.();
};

/** Sniffs a torrent file through the engine (deduplicated, cached under `key`). */
export function sniffTorrent(key: string, t: TorrentTarget, family?: string | null, reader: RangeReader = xhrReader): Promise<void> {
  if (trackEntry(key) || !opener) return Promise.resolve();
  setPending(key);
  const open = opener;
  return new Promise<void>((resolve) => {
    const job = async () => {
      running++;
      const t0 = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const url = await Promise.race([open(t), new Promise<null>((r) => (timer = setTimeout(() => r(null), TORRENT_SNIFF_MS)))]);
        const left = TORRENT_SNIFF_MS - (Date.now() - t0);
        const list = url && left > 500 ? await readTracks(url, undefined, reader, left) : null;
        if (list && list.tracks.some((x) => x.kind === 'audio')) setTracks(key, knownOf(list), family);
        else setFailed(key);
      } catch {
        setFailed(key);
      } finally {
        clearTimeout(timer);
        next();
        resolve();
      }
    };
    if (running < MAX_TORRENT_SNIFFS) void job();
    else queue.push(() => void job());
  });
}
