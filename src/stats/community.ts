// "Comparer avec la communauté" (opt-in, OFF by default): what a contribution may contain, how it
// is built from the local events, and how the network figures are read back. Pure — unit tested,
// and mirrored by the worklet validator (src/p2p/worklet/stats.js, checked by test/p2p/stats.test.mjs).
//
// A contribution is a coarse, noisy aggregate of at most one week of starts:
//   - per path, a histogram of the time to first frame in 11 fixed buckets (no individual value),
//   - three counters: starts that played, failed, stalled;
// every count gets two-sided geometric noise (local differential privacy, ε = 1 per count) and
// may go negative: the noise is zero-mean, so it cancels out when many contributions are summed.
// No title, series / episode id, URL, addon, timestamp of a start, identity or device key.
import type { PlaybackEvent, PlayPath } from './model';

export const STATS_VERSION = 1;
/** Upper edges (ms) of the time-to-first-frame buckets; the last bucket is open-ended. */
export const BUCKETS_MS = [500, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 20000] as const;
export const BUCKET_COUNT = BUCKETS_MS.length + 1;
export const COMMUNITY_PATHS: PlayPath[] = ['http-direct', 'debrid', 'torrent-engine', 'web-player', 'aggregator-playback'];
/** Bounds of one noisy count, enforced by every peer. */
export const COUNT_MIN = -16;
export const COUNT_MAX = 64;
export const TOTAL_MAX = 200;
/** A path is shared only with at least this many starts in the period. */
export const MIN_PATH_SAMPLES = 3;
/** Network figures are shown only from this many contributions (k-anonymity). */
export const K_MIN = 20;
export const WEEK_MS = 7 * 86_400_000;
export const EPSILON = 1;

export type Histogram = number[];
export type StatsContribution = {
  /** Random 128-bit id (hex), unrelated to anything else. */
  id: string;
  v: number;
  h: Partial<Record<PlayPath, Histogram>>;
  /** [played, failed, stalled] */
  s: [number, number, number];
};

export type CommunityStats = {
  contributions: number;
  h: Partial<Record<PlayPath, Histogram>>;
  s: [number, number, number];
};

export function bucketOf(ms: number): number {
  const i = BUCKETS_MS.findIndex((edge) => ms < edge);
  return i < 0 ? BUCKETS_MS.length : i;
}

/** Two-sided geometric noise (discrete Laplace), P(k) ∝ e^(-ε|k|). `rand` returns [0, 1). */
export function geometricNoise(rand: () => number, epsilon = EPSILON): number {
  const alpha = Math.exp(-epsilon);
  const geo = () => {
    // Number of failures before the first success, success probability 1 - alpha.
    const u = Math.max(rand(), Number.MIN_VALUE);
    return Math.floor(Math.log(u) / Math.log(alpha));
  };
  return geo() - geo();
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Contribution from the starts of the period, or null when there is too little to share.
 * `randomId` and `rand` are injected (crypto in the app, seeded in tests).
 */
export function buildContribution(events: PlaybackEvent[], randomId: string, rand: () => number): StatsContribution | null {
  const h: Partial<Record<PlayPath, Histogram>> = {};
  for (const path of COMMUNITY_PATHS) {
    const times = events.filter((e) => e.path === path && e.tFirstFrame != null).map((e) => e.tFirstFrame!);
    if (times.length < MIN_PATH_SAMPLES) continue;
    const hist = new Array<number>(BUCKET_COUNT).fill(0);
    for (const t of times) hist[bucketOf(t)]++;
    h[path] = hist.map((n) => clamp(Math.min(n, COUNT_MAX) + geometricNoise(rand), COUNT_MIN, COUNT_MAX));
  }
  if (!Object.keys(h).length) return null;
  const playedN = events.filter((e) => e.tFirstFrame != null).length;
  const failedN = events.filter((e) => e.failed).length;
  const stalledN = events.filter((e) => e.tFirstFrame != null && e.stalls > 0).length;
  const noisy = (n: number) => clamp(Math.min(n, TOTAL_MAX) + geometricNoise(rand), COUNT_MIN, TOTAL_MAX);
  return { id: randomId, v: STATS_VERSION, h, s: [noisy(playedN), noisy(failedN), noisy(stalledN)] };
}

const isCount = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= COUNT_MIN && (v as number) <= max;

/** Same rules as the worklet validator (shape, bounds, no extra field). */
export function isContribution(c: unknown): c is StatsContribution {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  const o = c as Record<string, unknown>;
  if (Object.keys(o).some((k) => !['id', 'v', 'h', 's'].includes(k))) return false;
  if (typeof o.id !== 'string' || !/^[0-9a-f]{32}$/.test(o.id) || o.v !== STATS_VERSION) return false;
  if (!Array.isArray(o.s) || o.s.length !== 3 || !o.s.every((n) => isCount(n, TOTAL_MAX))) return false;
  if (!o.h || typeof o.h !== 'object' || Array.isArray(o.h)) return false;
  const h = o.h as Record<string, unknown>;
  const keys = Object.keys(h);
  if (!keys.length || keys.some((k) => !(COMMUNITY_PATHS as string[]).includes(k))) return false;
  return keys.every((k) => Array.isArray(h[k]) && (h[k] as unknown[]).length === BUCKET_COUNT && (h[k] as unknown[]).every((n) => isCount(n, COUNT_MAX)));
}

/** Sums contributions (the worklet does the same over the room's view). */
export function mergeContributions(list: StatsContribution[]): CommunityStats {
  const out: CommunityStats = { contributions: 0, h: {}, s: [0, 0, 0] };
  const seen = new Set<string>();
  for (const c of list) {
    if (!isContribution(c) || seen.has(c.id)) continue;
    seen.add(c.id);
    out.contributions++;
    for (const [path, hist] of Object.entries(c.h) as [PlayPath, Histogram][]) {
      const acc = (out.h[path] ??= new Array<number>(BUCKET_COUNT).fill(0));
      hist.forEach((n, i) => (acc[i] += n));
    }
    c.s.forEach((n, i) => (out.s[i] += n));
  }
  return out;
}

/**
 * Quantile (ms) read from a summed histogram: noise sums are clamped at 0, then linear
 * interpolation inside the bucket (the open last bucket counts as 20–30 s).
 */
export function histQuantile(hist: Histogram | undefined, q: number): number | undefined {
  if (!hist) return undefined;
  const counts = hist.map((n) => Math.max(0, n));
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return undefined;
  const target = total * q;
  let acc = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] <= 0) continue;
    if (acc + counts[i] >= target) {
      const lo = i === 0 ? 0 : BUCKETS_MS[i - 1];
      const hi = i < BUCKETS_MS.length ? BUCKETS_MS[i] : 30000;
      return lo + ((target - acc) / counts[i]) * (hi - lo);
    }
    acc += counts[i];
  }
  return undefined;
}

export const histTotal = (hist: Histogram | undefined) => (hist ? Math.max(0, hist.reduce((a, b) => a + b, 0)) : 0);

/** Network figures the UI may show (null below the k-anonymity threshold). */
export function communityView(c: CommunityStats | null | undefined) {
  if (!c || c.contributions < K_MIN) return null;
  const all = new Array<number>(BUCKET_COUNT).fill(0);
  for (const hist of Object.values(c.h)) hist?.forEach((n, i) => (all[i] += n));
  const byPath: Partial<Record<PlayPath, { median?: number; p90?: number; n: number }>> = {};
  for (const [path, hist] of Object.entries(c.h) as [PlayPath, Histogram][]) {
    const n = histTotal(hist);
    // A path is shown only when enough starts back it.
    if (n >= K_MIN) byPath[path] = { median: histQuantile(hist, 0.5), p90: histQuantile(hist, 0.9), n };
  }
  const [playedN, failedN, stalledN] = c.s.map((n) => Math.max(0, n));
  return {
    contributions: c.contributions,
    overall: { median: histQuantile(all, 0.5), p90: histQuantile(all, 0.9) },
    byPath,
    success: playedN + failedN > 0 ? playedN / (playedN + failedN) : undefined,
    stallRate: playedN > 0 ? Math.min(1, stalledN / playedN) : undefined,
  };
}

/** UTC month of a time, the room a contribution goes to ("2026-10"). */
export function monthOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
