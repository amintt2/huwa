// Playback statistics: types, classification and aggregation (pure, no I/O — unit tested).
// What is measured stays on the device (./store.ts). Nothing here ever holds a URL, a title, a
// series / episode id or an addon URL: only how a start went (timings, path, engine, stalls).

/** How the played URL was obtained. */
export type PlayPath = 'http-direct' | 'debrid' | 'torrent-engine' | 'web-player' | 'aggregator-playback';
export const PATHS: PlayPath[] = ['http-direct', 'debrid', 'torrent-engine', 'web-player', 'aggregator-playback'];
export const PATH_LABEL: Record<PlayPath, string> = {
  'http-direct': 'HTTP direct',
  debrid: 'Débrid',
  'torrent-engine': 'Moteur torrent',
  'web-player': 'Lecteur web',
  'aggregator-playback': 'Lien d’agrégateur',
};

export type StartKind = 'start' | 'resume' | 'next';
export type EngineKind = 'native' | 'mpv';
export type NetKind = 'wifi' | 'cellular' | 'other';
/** Coarse failure category (never the error text: it can contain a URL). */
export type FailReason = 'no-source' | 'network' | 'http' | 'format' | 'timeout' | 'other';

export type PlaybackEvent = {
  /** When the start happened (ms since epoch). */
  at: number;
  kind: StartKind;
  path?: PlayPath;
  engine?: EngineKind;
  /** The pre-warmed player was taken over (no reload). */
  warm: boolean;
  /** ms from the tap (or the screen opening) to: first sources, source chosen, URL handed to the player, first frame. */
  tSources?: number;
  tDecision?: number;
  tUrl?: number;
  tFirstFrame?: number;
  /** Re-buffering after the first frame, over the first 5 minutes. */
  stalls: number;
  stalledMs: number;
  failed?: FailReason;
  fallbackToMpv: boolean;
  network?: NetKind;
};

/** Per-addon response of the stream search (keyed by manifest id, never by URL). */
export type AddonStat = { name: string; ok: number; fail: number; /** last response times (ms) of successful answers */ ms: number[] };

// ---------- classification ----------

const LOOPBACK = /^https?:\/\/(127\.|localhost[:/]|\[::1\])/i;
/** Content hosts of the debrid services (direct links handed out by an addon). */
const DEBRID_HOST = /(^|\.)(real-debrid\.com|rdeb\.io|alldebrid\.com|debrid\.it|premiumize\.me|torbox\.app|tb-cdn\.st|debrid-link\.(com|fr)|offcloud\.com|easydebrid\.com|put\.io)$/i;
/**
 * Addon "playback" endpoints that resolve the torrent through a debrid service on request
 * (Torrentio `/resolve/realdebrid/…`, Comet `/playback/…`, MediaFusion `/streaming_provider/…`,
 * AIOStreams / StremThru `/playback/`…): the addon server sits between the app and the file.
 */
const AGGREGATOR_PATH = /\/(resolve|playback|streaming_provider|realdebrid|alldebrid|premiumize|debridlink|torbox|offcloud|easydebrid|putio|stremthru)(\/|$)/i;

function hostAndPath(url: string): { host: string; path: string } | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::\d+)?([^?#]*)/i.exec(url);
  return m ? { host: m[1].toLowerCase(), path: m[2] || '/' } : null;
}

/** Path of a start, from the shape of what was played. The URL is only read, never kept. */
export function classifyPath(i: { web?: boolean; torrent?: boolean; url?: string | null }): PlayPath | undefined {
  if (i.web) return 'web-player';
  if (!i.url) return undefined;
  if (LOOPBACK.test(i.url)) return 'torrent-engine';
  if (i.torrent) return 'debrid';
  const hp = hostAndPath(i.url);
  if (!hp) return 'http-direct';
  if (DEBRID_HOST.test(hp.host)) return 'debrid';
  if (AGGREGATOR_PATH.test(hp.path)) return 'aggregator-playback';
  return 'http-direct';
}

/** Player / resolver error message → coarse category. */
export function failReason(message: string | undefined | null): FailReason {
  const m = String(message ?? '');
  if (/délai|timed?\s*out|timeout|-1001\b/i.test(m)) return 'timeout';
  if (/\b(4\d\d|5\d\d)\b|http|forbidden|not found|introuvable/i.test(m)) return 'http';
  if (/réseau|network|offline|hors ligne|connexion|connection|internet|-100[0-9]\b|socket|dns|host/i.test(m)) return 'network';
  if (/format|codec|unsupported|non pris en charge|decod|demux|cannot open|container|-1182\d|-1284\d/i.test(m)) return 'format';
  return 'other';
}

// ---------- aggregation ----------

/** Quantile with linear interpolation (q in 0..1) of unsorted values; undefined when empty. */
export function quantile(values: number[], q: number): number | undefined {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return undefined;
  const pos = (v.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
export const median = (values: number[]) => quantile(values, 0.5);

export type Dist = { n: number; median?: number; p90?: number };
export function dist(values: number[]): Dist {
  return { n: values.length, median: median(values), p90: quantile(values, 0.9) };
}

export type Group = Dist & {
  /** Starts that reached the first frame / starts that ended (failures included). */
  success?: number;
};

const played = (e: PlaybackEvent) => e.tFirstFrame != null;

function group(events: PlaybackEvent[]): Group {
  const times = events.filter(played).map((e) => e.tFirstFrame!);
  const ended = events.filter((e) => played(e) || e.failed);
  return { ...dist(times), success: ended.length ? times.length / ended.length : undefined };
}

export type Summary = {
  total: number;
  overall: Group;
  byPath: Partial<Record<PlayPath, Group>>;
  byEngine: Partial<Record<EngineKind, Group>>;
  warm: Group;
  cold: Group;
  byKind: Partial<Record<StartKind, Group>>;
  /** Steps of the start (medians, ms): sources, choice, URL. */
  steps: { sources?: number; decision?: number; url?: number };
  /** Share of played starts with at least one stall, and stalled time per stalled start. */
  stalls: { rate?: number; medianMs?: number; perStart?: number };
  fallbackRate?: number;
  /** Last starts, oldest first: time to first frame (ms) or null when it failed. */
  recent: (number | null)[];
  failures: Partial<Record<FailReason, number>>;
};

export function summarize(events: PlaybackEvent[], recentCount = 50): Summary {
  const by = <K extends string>(key: (e: PlaybackEvent) => K | undefined) => {
    const out: Partial<Record<K, Group>> = {};
    const keys = [...new Set(events.map(key).filter((k): k is K => !!k))];
    for (const k of keys) out[k] = group(events.filter((e) => key(e) === k));
    return out;
  };
  const playedEvents = events.filter(played);
  const stalled = playedEvents.filter((e) => e.stalls > 0);
  const failures: Partial<Record<FailReason, number>> = {};
  for (const e of events) if (e.failed) failures[e.failed] = (failures[e.failed] ?? 0) + 1;
  const native = events.filter((e) => e.engine || e.fallbackToMpv);
  return {
    total: events.length,
    overall: group(events),
    byPath: by((e) => e.path),
    byEngine: by((e) => e.engine),
    warm: group(events.filter((e) => e.warm)),
    cold: group(events.filter((e) => !e.warm && e.path !== 'web-player')),
    byKind: by((e) => e.kind),
    steps: {
      sources: median(events.flatMap((e) => (e.tSources != null ? [e.tSources] : []))),
      decision: median(events.flatMap((e) => (e.tDecision != null ? [e.tDecision] : []))),
      url: median(events.flatMap((e) => (e.tUrl != null ? [e.tUrl] : []))),
    },
    stalls: {
      rate: playedEvents.length ? stalled.length / playedEvents.length : undefined,
      medianMs: median(stalled.map((e) => e.stalledMs)),
      perStart: playedEvents.length ? playedEvents.reduce((s, e) => s + e.stalls, 0) / playedEvents.length : undefined,
    },
    fallbackRate: native.length ? native.filter((e) => e.fallbackToMpv).length / native.length : undefined,
    recent: events.slice(-recentCount).filter((e) => played(e) || e.failed).map((e) => (played(e) ? e.tFirstFrame! : null)),
    failures,
  };
}

export type AddonRow = { id: string; name: string; n: number; success: number; median?: number; p90?: number };

/** Per-addon table, most used first. */
export function addonTable(addons: Record<string, AddonStat>): AddonRow[] {
  return Object.entries(addons)
    .map(([id, a]) => ({ ...dist(a.ms), id, name: a.name, n: a.ok + a.fail, success: a.ok + a.fail ? a.ok / (a.ok + a.fail) : 0 }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

/** Appends to a bounded ring (oldest dropped). */
export function pushRing<T>(ring: T[], item: T, max: number): T[] {
  const next = ring.length >= max ? ring.slice(ring.length - max + 1) : ring.slice();
  next.push(item);
  return next;
}

/** "1,4 s", "850 ms", "—". */
export function formatMs(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms / 10) * 10} ms`;
  const s = ms / 1000;
  return `${s < 10 ? s.toFixed(1).replace('.', ',') : Math.round(s)} s`;
}

export const formatPct = (r: number | undefined) => (r == null ? '—' : `${Math.round(r * 100)} %`);
