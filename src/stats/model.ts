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
  /** The player opened the file (mpv `file-loaded`, expo-video `sourceLoad`), ms from the tap. */
  tFileLoaded?: number;
  /** Built-in torrent engine side of the start (path `torrent-engine`). */
  engineStart?: EngineStart;
};

/**
 * Where a torrent start spent its time inside the engine (native/huwa-torrent-core/src/timeline.rs),
 * in ms from the tap like the other marks. Numbers only: nothing names the torrent or the file.
 */
export type EngineStart = {
  /** Metadata usable; `metaFrom`: 0 unknown, 1 swarm probe cache, 2 magnet (peers), 3 already in the engine. */
  tMeta?: number;
  metaFrom: number;
  /** First connected peer, first verified piece of the file, first HTTP request of the player, first byte served. */
  tPeer?: number;
  tPiece?: number;
  tRequest?: number;
  tFirstByte?: number;
  /** Bytes served to the player before the first frame, HTTP requests, of which end-of-file index reads. */
  bytes: number;
  requests: number;
  tailRequests: number;
  /** Connected peers when the first byte went out. */
  peers?: number;
  /** Peers handed over by the probe, per-torrent peer limit, piece size (KiB). */
  initialPeers: number;
  peerLimit?: number;
  pieceKiB?: number;
};

export const META_FROM: Record<string, number> = { unknown: 0, probe: 1, magnet: 2, engine: 3 };
const META_LABEL = ['?', 'sonde', 'magnet', 'déjà là'] as const;

/** Engine timeline as reported by `status().start` (see src/torrent/types.ts). */
export type EngineTimeline = {
  startedAt: number;
  metaMs?: number | null;
  metaFrom?: string;
  firstPeerMs?: number | null;
  firstPieceMs?: number | null;
  firstRequestMs?: number | null;
  firstByteMs?: number | null;
  bytesServed: number;
  requests: number;
  tailRequests: number;
  peersAtFirstByte?: number | null;
  initialPeers?: number;
  peerLimit?: number | null;
  pieceBytes?: number | null;
};

/**
 * Engine marks (ms since its `startStream`, epoch `startedAt`) → ms from the tap of a trace that
 * started at epoch `traceAt`. `bytesAtFrame` replaces the running byte count when known.
 */
export function engineStartOf(t: EngineTimeline, traceAt: number, bytesAtFrame?: number): EngineStart {
  const shift = t.startedAt - traceAt;
  const at = (v: number | null | undefined) => (v == null ? undefined : Math.max(0, Math.round(v + shift)));
  return {
    tMeta: at(t.metaMs),
    metaFrom: META_FROM[t.metaFrom ?? 'unknown'] ?? 0,
    tPeer: at(t.firstPeerMs),
    tPiece: at(t.firstPieceMs),
    tRequest: at(t.firstRequestMs),
    tFirstByte: at(t.firstByteMs),
    bytes: Math.max(0, Math.round(bytesAtFrame ?? t.bytesServed)),
    requests: t.requests,
    tailRequests: t.tailRequests,
    peers: t.peersAtFirstByte ?? undefined,
    initialPeers: t.initialPeers ?? 0,
    peerLimit: t.peerLimit ?? undefined,
    pieceKiB: t.pieceBytes ? Math.round(t.pieceBytes / 1024) : undefined,
  };
}

export type Stage = { key: string; label: string; ms: number };

/**
 * The marks of a start in time order (ms from the tap), for the "Derniers démarrages" breakdown:
 * sources, choice, link, then the engine (metadata, first peer, first piece, first request, first
 * byte), the player opening the file, the image. Marks the start never reached are left out.
 */
export function startStages(e: PlaybackEvent): Stage[] {
  const g = e.engineStart;
  const raw: [string, string, number | undefined][] = [
    ['sources', 'sources', e.tSources],
    ['decision', 'choix', e.tDecision],
    ['url', 'lien', e.tUrl],
    ['meta', g ? `métadonnées (${META_LABEL[g.metaFrom] ?? '?'})` : 'métadonnées', g?.tMeta],
    ['peer', '1er pair', g?.tPeer],
    ['request', 'requête du lecteur', g?.tRequest],
    ['piece', '1re pièce', g?.tPiece],
    ['byte', '1er octet servi', g?.tFirstByte],
    ['loaded', 'fichier ouvert', e.tFileLoaded],
    ['frame', 'image', e.tFirstFrame],
  ];
  return raw.filter((r): r is [string, string, number] => r[2] != null).map(([key, label, ms]) => ({ key, label, ms })).sort((a, b) => a.ms - b.ms);
}

/** One line of "Derniers démarrages": result, the stages in order, the longest step, engine facts. */
export type StartLine = { label: string; value: string; failed: boolean; stages: string; slowest?: string; engine?: string };

const FAIL_SHORT: Record<FailReason, string> = { 'no-source': 'aucune source', network: 'réseau', http: 'lien refusé', format: 'format', timeout: 'trop long', other: 'échec' };

export function describeStart(e: PlaybackEvent): StartLine {
  const stages = startStages(e);
  const slow = slowestStep(stages);
  const g = e.engineStart;
  const who = [e.path ? PATH_LABEL[e.path] : undefined, e.engine === 'mpv' ? (e.fallbackToMpv ? 'mpv après AVPlayer' : 'mpv') : e.engine === 'native' ? 'AVPlayer' : undefined]
    .filter(Boolean)
    .join(' · ');
  const mib = (b: number) => `${(b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0).replace('.', ',')} Mo`;
  return {
    label: who || 'Lecture',
    value: e.tFirstFrame != null ? formatMs(e.tFirstFrame) : e.failed ? FAIL_SHORT[e.failed] : '—',
    failed: e.tFirstFrame == null,
    stages: stages.map((s) => `${s.label} ${formatMs(s.ms)}`).join(' → '),
    slowest: slow && slow.ms >= 1000 ? `le plus long : ${slow.from} → ${slow.to.label}, ${formatMs(slow.ms)}` : undefined,
    engine: g
      ? [
          `${mib(g.bytes)} servis`,
          `${g.requests} requête${g.requests > 1 ? 's' : ''}${g.tailRequests ? ` (dont ${g.tailRequests} en fin de fichier)` : ''}`,
          g.peers != null ? `${g.peers} pair${g.peers > 1 ? 's' : ''} au 1er octet` : undefined,
          g.initialPeers ? `${g.initialPeers} pairs de la sonde` : undefined,
          g.peerLimit ? `limite ${g.peerLimit}` : undefined,
          g.pieceKiB ? `pièces ${g.pieceKiB} Kio` : undefined,
        ]
          .filter(Boolean)
          .join(' · ')
      : undefined,
  };
}

/** The longest step of a start (from the previous mark), to say where the time went. */
export function slowestStep(stages: Stage[]): { from: string; to: Stage; ms: number } | undefined {
  let best: { from: string; to: Stage; ms: number } | undefined;
  let prev: Stage = { key: 'tap', label: 'appui', ms: 0 };
  for (const s of stages) {
    const ms = s.ms - prev.ms;
    if (!best || ms > best.ms) best = { from: prev.label, to: s, ms };
    prev = s;
  }
  return best;
}

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
