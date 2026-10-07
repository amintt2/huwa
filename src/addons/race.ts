// "Course des sources": which direct link starts fastest, and when to move to a better one.
// Pure functions only (unit-tested in __tests__/race.test.ts); the network side lives in
// ./race-runner.ts and the seamless player swap in components/player/seamless-upgrade.ts.
//
// 1. Each candidate link gets one small ranged GET (`bytes=0-262143`): time to first byte (which
//    includes redirects and the debrid resolution of aggregator links) and throughput.
// 2. Dead links (4xx/5xx, timeouts, an HTML/JSON page where a video was expected, empty file) are
//    eliminated before the player ever sees them.
// 3. Selection: language fit first (never a dubbed track for speed), then the best quality that is
//    "fast enough" for its own bitrate. The first acceptable answer wins after a short grace
//    window that lets a better candidate still in flight answer.
// 4. Upgrades: once playing, a strictly better quality that proved fast enough may replace the
//    current source, seamlessly when both play on the native engine (see `canSwapNow`).
import type { StreamItem } from './protocol';
import type { Quality } from './quality';

// ---------- measurement ----------

/** What one ranged GET observed (filled by a transport: XHR on device, fetch in Node). */
export type RawMeasure = {
  /** HTTP status of the final answer (after redirects), 0 = network error / no answer. */
  status: number;
  /** No answer (or no body) before the deadline. */
  timedOut?: boolean;
  contentType?: string | null;
  /** `Content-Range: bytes 0-262143/739426282`. */
  contentRange?: string | null;
  /** First bytes of the body (HTML sniffing), when read. */
  head?: Uint8Array | null;
  /** The whole body read (the file's first bytes: its audio tracks, see addons/track-sniff.ts). */
  body?: Uint8Array | null;
  /** Body bytes received. */
  bytes: number;
  /** Request start → response headers. */
  ttfbMs?: number;
  /** Request start → last body byte read (undefined when the body was not read). */
  totalMs?: number;
};

export type DeadReason = 'http' | 'timeout' | 'network' | 'not-media' | 'empty';

export type RaceResult = {
  alive: boolean;
  dead?: DeadReason;
  status?: number;
  ttfbMs?: number;
  /** Measured throughput over the probe (a lower bound: TCP slow start), Mb/s. */
  mbps?: number;
  /** File size from `Content-Range`, bytes. */
  size?: number;
  /** Server honoured the Range request (206). */
  ranged?: boolean;
  /** Headers came back but the body did not finish before the deadline. */
  stalled?: boolean;
  /**
   * HLS / DASH manifest: a few KB of text, so no throughput figure; the player adapts its
   * bitrate to the connection, so only the response time matters.
   */
  adaptive?: boolean;
  /** Epoch ms of the measurement (cache TTL). */
  at: number;
};

/** Below this many body bytes the throughput figure is noise. */
const MIN_BYTES_FOR_SPEED = 32 * 1024;
/** Floor on the transfer time so a burst served from a buffer does not read as infinite speed. */
const MIN_TRANSFER_MS = 20;

const NOT_MEDIA_TYPES = /^(text\/html|application\/xhtml\+xml|application\/json|text\/plain|application\/xml|text\/xml|application\/problem\+json)$/;

function looksLikeMarkup(head: Uint8Array | null | undefined): boolean {
  if (!head || !head.length) return false;
  let i = 0;
  // Skip a UTF-8 BOM and whitespace.
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x0a || head[i] === 0x0d || head[i] === 0x09)) i++;
  const start = String.fromCharCode(...head.subarray(i, i + 15)).toLowerCase();
  return start.startsWith('<!doctype') || start.startsWith('<html') || start.startsWith('<?xml') || start.startsWith('{"') || start.startsWith('{"error');
}

const ADAPTIVE_TYPES = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl|dash\+xml)|audio\/(x-)?mpegurl)$/;

/** HLS playlist (`#EXTM3U`) or DASH manifest (`<MPD`) from its type or first bytes. */
function isAdaptive(type: string, head: Uint8Array | null | undefined): boolean {
  if (ADAPTIVE_TYPES.test(type)) return true;
  if (!head || !head.length) return false;
  const start = String.fromCharCode(...head.subarray(0, 200)).replace(/^\uFEFF/, '').trimStart();
  return start.startsWith('#EXTM3U') || /^(<\?xml[^>]*>\s*)?<MPD[\s>]/i.test(start);
}

/** Total size from `Content-Range: bytes a-b/total` (`*` = unknown). */
export function sizeFromContentRange(cr: string | null | undefined): number | undefined {
  const m = /\/\s*(\d+)\s*$/.exec(cr ?? '');
  return m ? Number(m[1]) : undefined;
}

/** Throughput in Mb/s from a body transfer, or undefined when too little was read to tell. */
export function throughputMbps(bytes: number, ttfbMs: number | undefined, totalMs: number | undefined): number | undefined {
  if (bytes < MIN_BYTES_FOR_SPEED || totalMs == null) return undefined;
  const transfer = Math.max(totalMs - (ttfbMs ?? 0), MIN_TRANSFER_MS);
  return (bytes * 8) / transfer / 1000;
}

/** Turns a raw observation into an alive/dead verdict with timings. */
export function evaluateMeasure(raw: RawMeasure, now = Date.now()): RaceResult {
  const base = { status: raw.status || undefined, ttfbMs: raw.ttfbMs, at: now };
  if (raw.status === 0) return { ...base, alive: false, dead: raw.timedOut ? 'timeout' : 'network' };
  // 416 on `bytes=0-…` = empty file.
  if (raw.status === 416) return { ...base, alive: false, dead: 'empty' };
  if (raw.status >= 400 || raw.status < 200) return { ...base, alive: false, dead: 'http' };
  const type = (raw.contentType ?? '').split(';')[0].trim().toLowerCase();
  // Checked first: playlists are often served as text/plain, and a DASH manifest is XML.
  if (isAdaptive(type, raw.head)) return { ...base, alive: true, adaptive: true, stalled: raw.timedOut || undefined };
  if (NOT_MEDIA_TYPES.test(type) || looksLikeMarkup(raw.head)) return { ...base, alive: false, dead: 'not-media' };
  const size = sizeFromContentRange(raw.contentRange);
  if (size === 0) return { ...base, alive: false, dead: 'empty' };
  const ranged = raw.status === 206;
  // 206 with nothing in it.
  if (ranged && raw.totalMs != null && raw.bytes === 0) return { ...base, alive: false, dead: 'empty' };
  return {
    ...base,
    alive: true,
    ranged,
    size,
    mbps: throughputMbps(raw.bytes, raw.ttfbMs, raw.totalMs),
    stalled: raw.timedOut || undefined,
  };
}

// ---------- bitrate estimate ----------

/** Typical bitrates (Mb/s) of anime web releases per resolution, when nothing better is known. */
const TYPICAL_MBPS: Record<number, number> = { 2160: 18, 1080: 7, 720: 3.5, 480: 1.5 };
const UNKNOWN_QUALITY_MBPS = 6;
/** An anime episode, when the addon gives a size but no duration. */
const DEFAULT_DURATION_S = 24 * 60;

const textOf = (s: StreamItem) => `${s.name ?? ''} ${s.title ?? ''} ${s.description ?? ''}`;

/** Duration announced by the addon ("⏱️ 23m:40s", "1h:02m", "1h 2m 3s"), seconds. */
export function durationFromText(text: string): number | undefined {
  const m = /⏱️?\s*(?:(\d+)\s*h)?[\s:]*(?:(\d+)\s*m)?[\s:]*(?:(\d+)\s*s)?/i.exec(text);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  const sec = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return sec > 60 ? sec : undefined;
}

/**
 * Average video bitrate in Mb/s: the addon's own figure ("📊 7.42 Mbps", "967 Kbps"), else file
 * size ÷ duration, else a typical value for the resolution.
 */
export function estimateBitrateMbps(s: StreamItem, quality: Quality | null, durationS?: number): number {
  const text = textOf(s);
  const announced = /(\d+(?:[.,]\d+)?)\s*(m|k)(?:bps|b\/s|bit\/s)\b/i.exec(text);
  if (announced) {
    const v = Number(announced[1].replace(',', '.')) / (announced[2].toLowerCase() === 'k' ? 1000 : 1);
    if (v > 0.1 && v < 200) return v;
  }
  const size = s.behaviorHints?.videoSize;
  if (size && size > 0) {
    const d = durationS ?? durationFromText(text) ?? DEFAULT_DURATION_S;
    const v = (size * 8) / d / 1e6;
    if (v > 0.1 && v < 200) return v;
  }
  return quality ? TYPICAL_MBPS[quality] : UNKNOWN_QUALITY_MBPS;
}

// ---------- verdicts ----------

export type Speed = 'fast' | 'ok' | 'slow' | 'dead';

/**
 * A 256 KiB probe measures 2–3× less than the sustained rate (TCP slow start; measured on
 * Real-Debrid links: 13–16 Mb/s on the probe, 35–49 Mb/s over 2 MiB). So "probe ≥ bitrate"
 * already means a 2–3× margin over the video bitrate: that is FAST. OK still keeps ~1.5×.
 */
export const FAST_MARGIN = 1;
export const OK_MARGIN = 0.5;
/** Time to first byte beyond which a link is never called fast (the user waits that long). */
export const FAST_TTFB_MS = 3000;
export const OK_TTFB_MS = 6000;

/** How well a measured link can sustain a stream of `bitrateMbps`. */
export function speedVerdict(r: RaceResult, bitrateMbps: number): Speed {
  if (!r.alive) return 'dead';
  if (r.stalled) return 'slow';
  const ttfb = r.ttfbMs ?? Infinity;
  if (r.adaptive) return ttfb <= FAST_TTFB_MS ? 'fast' : ttfb <= OK_TTFB_MS ? 'ok' : 'slow';
  if (r.mbps == null) {
    // Range ignored (no throughput figure): judge on the response time alone, never "fast".
    return ttfb <= FAST_TTFB_MS ? 'ok' : 'slow';
  }
  if (r.mbps >= bitrateMbps * FAST_MARGIN && ttfb <= FAST_TTFB_MS) return 'fast';
  if (r.mbps >= bitrateMbps * OK_MARGIN && ttfb <= OK_TTFB_MS) return 'ok';
  return 'slow';
}

// ---------- initial selection ----------

/** Grace window after the first acceptable answer, for a better candidate still in flight. */
export const GRACE_MS = 800;
/** Past this, an "ok" (not fast) link is good enough. */
export const SOFT_DEADLINE_MS = 3500;
/** Past this, anything alive (even slow), then the plain ranking, rather than more waiting. */
export const HARD_DEADLINE_MS = 8000;

export type RaceCandidate = {
  key: string;
  /** Language fit, lower is better (see ./audio `langScore`). */
  lang: number;
  /** Quality score, higher is better (preferred-quality cap already applied). */
  quality: number;
  bitrateMbps: number;
  /** Measurement, once done. */
  result?: RaceResult;
  /** Queued or in flight: an answer will come. False = not raced (budget, torrent…). */
  probing: boolean;
  /** Same release as the one played for the previous episode (Stremio `bingeGroup`). */
  binge?: boolean;
  /** Elapsed race time (ms) when its result arrived. */
  doneAtMs?: number;
};

export type RaceDecision =
  | { key: string; why: 'fast' | 'binge' | 'ok' | 'alive' | 'fallback' }
  | { key: null; waitMs: number }
  | { key: null; exhausted: true };

const verdictOf = (c: RaceCandidate): Speed | undefined => (c.result ? speedVerdict(c.result, c.bitrateMbps) : undefined);

function bestBy(list: RaceCandidate[]): RaceCandidate | undefined {
  // Quality first, then the quickest to answer, then throughput, then the given order.
  return list.reduce<RaceCandidate | undefined>((best, c) => {
    if (!best) return c;
    if (c.quality !== best.quality) return c.quality > best.quality ? c : best;
    const ta = c.result?.ttfbMs ?? Infinity;
    const tb = best.result?.ttfbMs ?? Infinity;
    if (Math.abs(ta - tb) > 250) return ta < tb ? c : best;
    return (c.result?.mbps ?? 0) > (best.result?.mbps ?? 0) ? c : best;
  }, undefined);
}

/**
 * Which candidate to start with, given what the race has learned after `elapsedMs`.
 * `candidates` are in preference order (best first) — the plain ranking used as last resort.
 */
export function decideStart(candidates: RaceCandidate[], elapsedMs: number): RaceDecision {
  const alive = candidates.filter((c) => !c.result || c.result.alive);
  if (!alive.length) return { key: null, exhausted: true };
  // Language first: only the best language tier still possible competes.
  const tier = Math.min(...alive.map((c) => c.lang));
  const T = alive.filter((c) => c.lang === tier);
  const pending = T.filter((c) => c.probing && !c.result);
  const measured = T.filter((c) => c.result);
  // Nothing in this tier is (or will be) measured: plain ranking, no waiting.
  if (!pending.length && !measured.length) return { key: T[0].key, why: 'fallback' };

  // Same release as the previous episode: kept as long as it is not slow.
  const binge = T.find((c) => c.binge);
  if (binge) {
    const v = verdictOf(binge);
    if (v === 'fast' || v === 'ok' || (!binge.probing && !binge.result)) return { key: binge.key, why: 'binge' };
    if (!binge.result && elapsedMs < SOFT_DEADLINE_MS) return { key: null, waitMs: SOFT_DEADLINE_MS - elapsedMs };
  }

  const fast = T.filter((c) => verdictOf(c) === 'fast');
  if (fast.length) {
    const best = bestBy(fast)!;
    const firstAt = Math.min(...fast.map((c) => c.doneAtMs ?? elapsedMs));
    const better = pending.some((c) => c.quality > best.quality);
    const left = firstAt + GRACE_MS - elapsedMs;
    if (better && left > 0) return { key: null, waitMs: left };
    return { key: best.key, why: 'fast' };
  }

  const ok = T.filter((c) => verdictOf(c) === 'ok');
  if (ok.length && (elapsedMs >= SOFT_DEADLINE_MS || !pending.length)) return { key: bestBy(ok)!.key, why: 'ok' };
  if (pending.length && elapsedMs < HARD_DEADLINE_MS) {
    const next = ok.length || elapsedMs < SOFT_DEADLINE_MS ? SOFT_DEADLINE_MS : HARD_DEADLINE_MS;
    return { key: null, waitMs: Math.max(50, next - elapsedMs) };
  }
  // Deadline: anything alive that answered (best quality), else the plain ranking.
  const answered = T.filter((c) => c.result?.alive);
  if (answered.length) return { key: bestBy(answered)!.key, why: 'alive' };
  return { key: T[0].key, why: 'fallback' };
}

// ---------- upgrades ----------

export type EngineKind = 'native' | 'mpv' | 'web' | 'unknown';

export type UpgradeSide = {
  key: string;
  lang: number;
  /** Resolution (2160/1080/720/480, 0 unknown) — an upgrade must be strictly higher. */
  resolution: number;
  /** Quality score (preferred-quality cap applied): must not get worse either. */
  quality: number;
  bingeGroup?: string;
  /** Hosted player page: never part of an upgrade. */
  web?: boolean;
};

export type UpgradeCandidate = UpgradeSide & { speed?: Speed; mbps?: number };

/** Release identity without its resolution token: "addon|1080p|WEB-DL|FLE" → "addon||WEB-DL|FLE". */
export function bingeFamily(group: string | undefined): string | undefined {
  return group?.replace(/\b(2160|1440|1080|720|576|480|360)p\b|\b4k\b|\buhd\b|\bfhd\b/gi, '').replace(/\s+/g, ' ');
}

/** 2 = same bingeGroup, 1 = same release at another resolution, 0 = unrelated. */
export function bingeAffinity(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0;
  if (a === b) return 2;
  return bingeFamily(a) === bingeFamily(b) ? 1 : 0;
}

/**
 * Better source to move to while `current` plays, or null. Same language fit (or better), strictly
 * higher resolution, proved fast. Same release family preferred, then resolution, then speed.
 */
export function pickUpgrade(current: UpgradeSide, candidates: UpgradeCandidate[], manual: boolean): UpgradeCandidate | null {
  if (manual || current.web) return null;
  const ok = candidates.filter(
    (c) => c.key !== current.key && !c.web && c.speed === 'fast' && c.lang <= current.lang && c.resolution > current.resolution && c.quality > current.quality,
  );
  if (!ok.length) return null;
  return ok.reduce((best, c) => {
    const fa = bingeAffinity(current.bingeGroup, c.bingeGroup);
    const fb = bingeAffinity(current.bingeGroup, best.bingeGroup);
    if (fa !== fb) return fa > fb ? c : best;
    if (c.quality !== best.quality) return c.quality > best.quality ? c : best;
    return (c.mbps ?? 0) > (best.mbps ?? 0) ? c : best;
  });
}

/**
 * Seamless swap: AVPlayer → AVPlayer (a hidden expo-video player), or from mpv to anything (a
 * second hidden mpv view: mpv plays whatever AVPlayer plays). AVPlayer → an mpv-only source would
 * change the engine on screen: not seamless.
 */
export const canSwapEngines = (from: EngineKind, to: EngineKind) => (from === 'native' && to === 'native') || (from === 'mpv' && to !== 'web');

/** Two releases whose lengths differ more than this are other cuts: swapping would jump. */
export const SWAP_TIMELINE_TOLERANCE_S = 3;
/** Same timeline (or a length still unknown on either side). */
export const sameTimeline = (a: number, b: number) => !(a > 0 && b > 0 && isFinite(a) && isFinite(b)) || Math.abs(a - b) <= SWAP_TIMELINE_TOLERANCE_S;

/** No swap during the first seconds of a source. */
export const SWAP_MIN_PLAYED_MS = 10_000;
/** At most one swap per window. */
export const SWAP_COOLDOWN_MS = 30_000;
/** Not worth it this close to the end. */
export const SWAP_MIN_REMAINING_S = 60;

export type SwapState = {
  /** Time since the current source started playing. */
  playedMs: number;
  /** Time since the last swap (null = none yet). */
  sinceSwapMs: number | null;
  playing: boolean;
  /** Seeking, buffering or loading. */
  busy: boolean;
  /** Picture in picture / AirPlay. */
  external: boolean;
  /** Seconds left in the episode (Infinity when unknown). */
  remainingS: number;
};

/** Why a swap cannot happen right now, or null when it can. */
export function swapBlocker(s: SwapState): string | null {
  if (!s.playing) return 'paused';
  if (s.busy) return 'busy';
  if (s.external) return 'external';
  if (s.playedMs < SWAP_MIN_PLAYED_MS) return 'too-early';
  if (s.sinceSwapMs != null && s.sinceSwapMs < SWAP_COOLDOWN_MS) return 'cooldown';
  if (s.remainingS < SWAP_MIN_REMAINING_S) return 'near-end';
  return null;
}

export const canSwapNow = (s: SwapState) => swapBlocker(s) === null;

/** Seconds of lead the warm player is parked ahead of the current position. */
export const SWAP_LEAD_S = 6;
/** Buffered seconds the warm player needs past its parking point. */
export const SWAP_MIN_BUFFER_S = 4;
/** A warm player not ready by then is stalled: abort. */
export const SWAP_WARM_TIMEOUT_MS = 25_000;

/** When the buffered position is unknown (-1), time parked before trusting the warm player. */
export const SWAP_SETTLE_MS = 3000;

export type WarmState = {
  /** Loaded and parked at `target`. */
  ready: boolean;
  /** Where the warm player is parked (s). */
  target: number;
  /** Its buffered position (s), -1 when the engine cannot tell. */
  buffered: number;
  /** Time since it was parked at `target`. */
  parkedMs: number;
  /** Current position of the main player (s). */
  mainTime: number;
};

/** Seconds before the parking point at which the swap is timed precisely (one-shot timer). */
export const SWAP_ARM_S = 0.6;

/**
 * Next step of the swap once the warm player exists: `wait`, `retarget` (main jumped past or far
 * before the parking point — park again at main + lead), `arm` (ready, main about to reach the
 * point: time the swap precisely) or `swap` (main reached the point).
 */
export function warmStep(w: WarmState): 'wait' | 'retarget' | 'arm' | 'swap' {
  if (w.mainTime > w.target + 0.75 || w.mainTime < w.target - SWAP_LEAD_S - 3) return 'retarget';
  if (!w.ready) return 'wait';
  const buffered = w.buffered >= 0 ? w.buffered >= w.target + SWAP_MIN_BUFFER_S : w.parkedMs >= SWAP_SETTLE_MS;
  if (!buffered) return 'wait';
  if (w.mainTime >= w.target - 0.05) return 'swap';
  return w.target - w.mainTime <= SWAP_ARM_S ? 'arm' : 'wait';
}

// ---------- labels ----------

const fmt = (n: number, digits: number) => n.toFixed(digits).replace('.', ',');

/** Sources menu label: "1,2 s · 38 Mb/s" (with a ⚡ icon when fast), "lent · 4,1 s", "hors ligne (404)", "test…". */
export function speedLabel(r: RaceResult | undefined, speed: Speed | undefined, probing: boolean): string | null {
  if (!r) return probing ? 'test…' : null;
  if (!r.alive) {
    if (r.dead === 'timeout') return 'hors ligne (délai dépassé)';
    if (r.dead === 'not-media') return 'hors ligne (page, pas une vidéo)';
    if (r.dead === 'empty') return 'hors ligne (fichier vide)';
    return r.status ? `hors ligne (${r.status})` : 'hors ligne';
  }
  const t = r.ttfbMs != null ? `${fmt(r.ttfbMs / 1000, 1)} s` : '';
  const mb = r.mbps != null ? `${r.mbps >= 10 ? Math.round(r.mbps) : fmt(r.mbps, 1)} Mb/s` : '';
  const parts = [t, mb].filter(Boolean).join(' · ');
  if (speed === 'slow') return `lent${parts ? ` · ${parts}` : ''}`;
  return parts || 'en ligne';
}
