// Continuous source controller ("ABR across sources"): once a source plays, the alternatives keep
// being evaluated in the background and the episode moves to a better one without the user
// having to do anything —
//   - up to a higher quality on a good network (seamless swap through a warm hidden player),
//   - away from a source that stalls, even to a lower quality, before the next stall,
//   - away from a source that never shows its first frame (slow start),
//   - away from another work under the same title (file length far from the official one).
// Pure state machine (no React, no player, no network: unit-tested in
// __tests__/source-controller.test.ts). Inputs: the playing source and its playback stats, the
// candidates with their latest probes, the network class. Output: hold / prepare X (warm it for
// a seamless swap) / switch to X now / drop the current source (broken), plus which candidates to
// re-probe. The wiring (use-source-controller.ts) only feeds it and applies its answers.
//
// Hysteresis, so it never flaps: minimum dwell time on a source, cooldown after a switch, a
// throughput margin to upgrade, never back to a source left for stalling (remembered as bad for
// the episode), a cap on switches per episode. The language tier never changes.
import type { NetClass } from '@/settings/network-budget';
import { backgroundProbes, upgradeCap } from '@/settings/network-budget';

import { bingeAffinity, type Speed } from './race';

export type SourceKind = 'http' | 'torrent';
/** Why the controller moved (switch stats). */
export type SwitchReason = 'upgrade' | 'stall' | 'weak-swarm' | 'slow-start' | 'wrong-duration';

// ---------- thresholds ----------

/** Stalls are counted over this window. */
export const HEALTH_WINDOW_MS = 90_000;
/** Stalls in the window: 2 = bad (move when something better is known), 3 = critical (move now). */
export const BAD_STALLS = 2;
export const CRITICAL_STALLS = 3;
/** Stalled time in the window: bad / critical. */
export const BAD_STALLED_MS = 4000;
export const CRITICAL_STALLED_MS = 10_000;
/** The stall in progress: bad / critical. */
export const BAD_STALL_NOW_MS = 2500;
export const CRITICAL_STALL_NOW_MS = 6000;
/** A torrent with this many live peers or fewer that stalled twice is not coming back. */
export const WEAK_SWARM_PEERS = 1;
/** Buffer ahead (s) below which a draining buffer is a risk. */
export const RISK_BUFFER_S = 6;
/** Draining faster than this (s of buffer per s) = the source delivers less than the bitrate. */
export const DRAIN_RATE = -0.25;
/** Below this buffer (s) a stability switch is done at once (hard), not through a warm player. */
export const HARD_BUFFER_S = 4;

/** No first frame after this long (ms since the URL was handed to the player): slow start. */
export const SLOW_START_HTTP_MS = 8000;
export const SLOW_START_TORRENT_MS = 12_000;

/** Minimum time on a source before leaving it for stability (critical: no minimum). */
export const STABLE_DWELL_MS = 8000;
/** Cooldown after any switch before a stability switch (critical: `CRITICAL_COOLDOWN_MS`). */
export const STABLE_COOLDOWN_MS = 20_000;
export const CRITICAL_COOLDOWN_MS = 8000;
/** A seamless stability switch not ready by then becomes a hard one. */
export const STABLE_PREPARE_MAX_MS = 12_000;

/** Minimum time on a source before an upgrade. */
export const UPGRADE_DWELL_MS = 20_000;
/** Cooldown after a switch before an upgrade; after a stability switch, much longer. */
export const UPGRADE_COOLDOWN_MS = 60_000;
export const UPGRADE_AFTER_STABILITY_MS = 180_000;
/** No stall at all for this long before an upgrade. */
export const UPGRADE_CLEAN_MS = 60_000;
/** Probe throughput needed over the candidate's own bitrate (on top of the "fast" verdict). */
export const UPGRADE_MARGIN = 1.5;
/** Not worth it this close to the end (s). */
export const UPGRADE_MIN_REMAINING_S = 90;
/** An upgrade warm-up abandoned past this. */
export const UPGRADE_PREPARE_MAX_MS = 40_000;

/** Probe results older than this are not trusted for a decision. */
export const PROBE_FRESH_MS = 3 * 60_000;
/** Re-probe rounds while the current source struggles. */
export const URGENT_PROBE_MS = 10_000;
/** Throughput over bitrate that makes a stability candidate "comfortable". */
export const STABLE_HEADROOM = 1.5;
/** Switches per episode, all reasons together. */
export const MAX_SWITCHES = 8;

/** Wrong work: file length vs the official episode length (AniList). */
export const DURATION_MAX_RATIO = 1.8;
/** Premieres and finales are often double-length. */
export const DURATION_MAX_RATIO_EDGE = 2.6;
export const DURATION_MIN_RATIO = 0.5;
/** Short-format shows (a few minutes per episode) are not checked. */
export const DURATION_MIN_OFFICIAL_MIN = 8;

// ---------- inputs ----------

export type CtlCandidate = {
  key: string;
  kind: SourceKind;
  /** Language fit, lower is better (./audio `langScore`): only the current tier is considered. */
  lang: number;
  /** 2160 / 1080 / 720 / 480, 0 unknown. */
  resolution: number;
  /** Quality score (preferred-quality cap applied), higher is better. */
  quality: number;
  bitrateMbps: number;
  bingeGroup?: string;
  /** Latest HTTP probe (ranged GET), `at` = when (same clock as `now`). */
  http?: { speed: Speed; mbps?: number; ttfbMs?: number; at: number };
  /** Latest swarm probe (on-device engine). */
  swarm?: { connected: number; healthy: boolean; local?: boolean; failed?: boolean; at: number };
  /** Can be re-measured in the background (HTTP link known, or torrent the engine can probe). */
  probeable: boolean;
  /** Hosted player page: never a target. */
  web?: boolean;
};

export type CurrentSource = Pick<CtlCandidate, 'key' | 'kind' | 'lang' | 'resolution' | 'quality' | 'bitrateMbps' | 'bingeGroup'>;

/** What the player observed on the current source. Times are ms on the same clock as `now`. */
export type Playback = {
  /** First frame shown for this source. */
  started: boolean;
  /** Since the source was handed to the player. */
  sinceLoadMs: number;
  /** Since its first frame (0 before). */
  sincePlayMs: number;
  playing: boolean;
  /** Seeking (user) or still opening: not a stall. */
  busy: boolean;
  /** Picture in picture / AirPlay. */
  external: boolean;
  position: number;
  /** Seconds, 0 / NaN when unknown. */
  duration: number;
  /** Seconds buffered ahead of the playhead, -1 unknown. */
  bufferAhead: number;
  /** Change of `bufferAhead` per second of wall time over the last ~10 s (NaN unknown). */
  bufferTrend: number;
  /** Stalls after the first frame (start time, length so far), oldest first; the ongoing one included. */
  stalls: { at: number; ms: number }[];
  /** Length of the stall in progress (0 = playing normally). */
  stalledNowMs: number;
  /** Download rate of the current source when known (torrent engine), Mb/s. */
  throughputMbps?: number;
  /** Live peers of the current torrent. */
  peers?: number;
};

/** The episode as the catalog knows it (wrong-work check). */
export type EpisodeInfo = {
  /** Official length per episode (AniList `duration`), minutes. Undefined = unknown, no check. */
  officialMin?: number;
  /** First or last episode of the season (often double-length). */
  edge?: boolean;
};

export type CtlSettings = {
  /** "Changement de source automatique" (Réglages). Off: only broken / wrong sources are left. */
  auto: boolean;
  net: NetClass;
  /** What the device and its screen can use (see `deviceMaxResolution`). */
  deviceMaxRes: number;
};

export type CtlInput = {
  now: number;
  current: CurrentSource | null;
  /** The playing source's stream name says recap / special / compilation: no length check. */
  currentExempt?: boolean;
  /** Episodes the playing file holds ("E01-02" = 2). */
  currentEpisodes?: number;
  playback: Playback;
  candidates: CtlCandidate[];
  settings: CtlSettings;
  episode: EpisodeInfo;
};

// ---------- state ----------

export type CtlState = {
  /** Sources not to go to again for this episode, and why. */
  bad: Record<string, SwitchReason | 'failed'>;
  /** Upgrades tried and abandoned (warm player stalled, other engine…). */
  noUpgrade: string[];
  /** Seamless warm-up failed: the next stability switch to it is hard. */
  seamlessFailed: string[];
  lastSwitchAt: number | null;
  lastSwitchReason: SwitchReason | null;
  switches: number;
  preparing: { key: string; reason: SwitchReason; since: number; stallsAtStart: number } | null;
  lastProbeRound: number | null;
  /** Source whose file length was already checked. */
  durationChecked: string | null;
};

export const initialState = (): CtlState => ({
  bad: {},
  noUpgrade: [],
  seamlessFailed: [],
  lastSwitchAt: null,
  lastSwitchReason: null,
  switches: 0,
  preparing: null,
  lastProbeRound: null,
  durationChecked: null,
});

export type CtlAction =
  | { type: 'hold'; why: string }
  /** Warm `key` in a hidden player, the player swaps when it is ready (seamless). */
  | { type: 'prepare'; key: string; reason: SwitchReason }
  /** Switch to `key` now, at the current position (a short reload). */
  | { type: 'switch'; key: string; reason: SwitchReason }
  /** The current source is broken / the wrong work: drop it like a failed one. */
  | { type: 'drop'; key: string; reason: SwitchReason }
  /** Abandon the warm-up in progress. */
  | { type: 'cancel'; key: string; why: string };

export type CtlStep = { state: CtlState; action: CtlAction; reprobe: string[] };

// ---------- health ----------

export type HealthLevel = 'ok' | 'risk' | 'bad' | 'critical';
export type Health = { level: HealthLevel; why: string; recentStalls: number; stalledMs: number };

export function assessHealth(cur: Pick<CurrentSource, 'kind' | 'bitrateMbps'>, p: Playback, now: number): Health {
  const recent = p.stalls.filter((s) => s.at >= now - HEALTH_WINDOW_MS);
  const stalledMs = recent.reduce((t, s) => t + s.ms, 0);
  const n = recent.length;
  const base = { recentStalls: n, stalledMs };
  if (!p.started) return { level: 'ok', why: 'starting', ...base };
  const weakSwarm = cur.kind === 'torrent' && p.peers != null && p.peers <= WEAK_SWARM_PEERS;
  if (weakSwarm && n >= 2) return { level: 'critical', why: 'weak-swarm', ...base };
  if (n >= CRITICAL_STALLS) return { level: 'critical', why: 'stalls', ...base };
  if (stalledMs >= CRITICAL_STALLED_MS) return { level: 'critical', why: 'stalled-long', ...base };
  if (p.stalledNowMs >= CRITICAL_STALL_NOW_MS) return { level: 'critical', why: 'stalled-now', ...base };
  if (n >= BAD_STALLS) return { level: 'bad', why: weakSwarm ? 'weak-swarm' : 'stalls', ...base };
  if (stalledMs >= BAD_STALLED_MS || p.stalledNowMs >= BAD_STALL_NOW_MS) return { level: 'bad', why: weakSwarm ? 'weak-swarm' : 'stalled', ...base };
  // Buffer known and close to the end of the file: nothing left to download.
  const nearEnd = p.duration > 0 && p.bufferAhead >= 0 && p.position + p.bufferAhead >= p.duration - 1;
  if (!nearEnd && p.playing && p.bufferAhead >= 0) {
    if (p.bufferAhead < RISK_BUFFER_S && p.bufferTrend < DRAIN_RATE) return { level: 'risk', why: 'draining', ...base };
    if (p.throughputMbps != null && p.throughputMbps < cur.bitrateMbps * 0.9 && p.bufferAhead < 15) return { level: 'risk', why: 'slow-download', ...base };
  }
  if (weakSwarm && n >= 1) return { level: 'risk', why: 'weak-swarm', ...base };
  return { level: 'ok', why: '', ...base };
}

// ---------- wrong work ----------

export type DurationVerdict = 'ok' | 'too-long' | 'too-short' | 'unknown';

/**
 * The file against the official episode length. Too long (> 1.8×, 2.6× for a premiere / finale,
 * scaled by the episodes a multi-episode file holds): another work (a 1 h live-action episode for a
 * 24 min anime). Too short (< 0.5×): a preview, a trailer, a cut file. Unknown when either side is.
 */
export function durationVerdict(fileS: number, ep: EpisodeInfo, episodesInFile = 1): DurationVerdict {
  const off = ep.officialMin;
  if (!off || off < DURATION_MIN_OFFICIAL_MIN || !Number.isFinite(fileS) || fileS <= 0) return 'unknown';
  const ratio = fileS / (off * 60);
  const max = (ep.edge ? DURATION_MAX_RATIO_EDGE : DURATION_MAX_RATIO) * Math.max(1, episodesInFile);
  if (ratio > max) return 'too-long';
  if (ratio < DURATION_MIN_RATIO) return 'too-short';
  return 'ok';
}

/** Names that say the file is not a regular episode (its length says nothing). */
export const EXEMPT_NAME = /\b(recap|r[ée]sum[ée]|compilation|special|sp\d|ova|oad|movie|film|総集編)\b/i;

/** Episodes in a file from its name ("E01-E02", "01~02"), 1 when nothing says otherwise. */
export function episodesInName(name: string): number {
  const m = /(?:\b|S\d{1,2})E?(\d{1,4})\s?[-~]\s?E?(\d{1,4})\b(?!\s?(?:p|bit|fps))/i.exec(name);
  if (!m) return 1;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return b > a && b - a < 4 ? b - a + 1 : 1;
}

// ---------- device ----------

/**
 * Highest resolution worth playing: 4K only with a hardware HEVC decoder and a screen that shows
 * it (long side ≥ 2400 px, iPhone Plus / Pro Max class) or an external display (AirPlay).
 */
export function deviceMaxResolution(d: { longSidePx: number; hevcHw: boolean; external?: boolean }): number {
  if (!d.hevcHw) return 1080;
  if (d.external || d.longSidePx >= 2400) return 2160;
  if (d.longSidePx < 1280) return 720;
  return 1080;
}

// ---------- candidates ----------

const fresh = (at: number | undefined, now: number) => at != null && now - at <= PROBE_FRESH_MS;

/** Measured and believable as a smoother source right now. */
function credible(c: CtlCandidate, now: number): boolean {
  if (c.web) return false;
  if (c.kind === 'http') return !!c.http && fresh(c.http.at, now) && (c.http.speed === 'fast' || c.http.speed === 'ok');
  // Never an unprobed torrent, never a weak swarm.
  return !!c.swarm && fresh(c.swarm.at, now) && !c.swarm.failed && (!!c.swarm.local || c.swarm.healthy);
}

/** Expected throughput over bitrate (how comfortably it can play). */
export function headroom(c: CtlCandidate): number {
  if (c.kind === 'torrent') {
    if (c.swarm?.local) return 10;
    if (!c.swarm?.healthy) return 0.5;
    return STABLE_HEADROOM + Math.min(c.swarm.connected, 20) / 20;
  }
  if (!c.http) return 0;
  if (c.http.mbps != null && c.bitrateMbps > 0) return c.http.mbps / c.bitrateMbps;
  return c.http.speed === 'fast' ? 1.2 : 0.7;
}

/**
 * Smoother source than the current one: same language tier, measured, not bad. Comfortable ones
 * first (headroom ≥ 1.5, the best quality among them — HTTP before torrents when the current one is
 * a torrent), else the one with the most headroom (≥ 1). Null when nothing is known to be better.
 */
export function pickStable(cur: CurrentSource, cands: CtlCandidate[], state: CtlState, now: number): CtlCandidate | null {
  const ok = cands.filter((c) => c.key !== cur.key && c.lang === cur.lang && !state.bad[c.key] && credible(c, now));
  if (!ok.length) return null;
  const preferHttp = cur.kind === 'torrent';
  const comfy = ok.filter((c) => headroom(c) >= STABLE_HEADROOM);
  if (comfy.length) {
    return comfy.reduce((best, c) => {
      if (preferHttp && c.kind !== best.kind) return c.kind === 'http' ? c : best;
      if (c.quality !== best.quality) return c.quality > best.quality ? c : best;
      return headroom(c) > headroom(best) ? c : best;
    });
  }
  const best = ok.reduce((a, c) => (headroom(c) > headroom(a) ? c : a));
  return headroom(best) >= 1 ? best : null;
}

/**
 * Higher quality to move to on a good network: same language tier, HTTP (a torrent upgrade would
 * download two files at once), strictly higher resolution within the cap, proved fast with a
 * margin over its own bitrate. Same release family first, then resolution, then throughput.
 */
export function pickUpgradeTarget(cur: CurrentSource, cands: CtlCandidate[], state: CtlState, now: number, cap: number): CtlCandidate | null {
  const ok = cands.filter(
    (c) =>
      c.key !== cur.key &&
      c.kind === 'http' &&
      !c.web &&
      c.lang === cur.lang &&
      !state.bad[c.key] &&
      !state.noUpgrade.includes(c.key) &&
      c.resolution > cur.resolution &&
      c.resolution <= cap &&
      c.quality > cur.quality &&
      !!c.http &&
      fresh(c.http.at, now) &&
      c.http.speed === 'fast' &&
      c.http.mbps != null &&
      c.http.mbps >= c.bitrateMbps * UPGRADE_MARGIN,
  );
  if (!ok.length) return null;
  return ok.reduce((best, c) => {
    const fa = bingeAffinity(cur.bingeGroup, c.bingeGroup);
    const fb = bingeAffinity(cur.bingeGroup, best.bingeGroup);
    if (fa !== fb) return fa > fb ? c : best;
    if (c.resolution !== best.resolution) return c.resolution > best.resolution ? c : best;
    return (c.http!.mbps ?? 0) > (best.http!.mbps ?? 0) ? c : best;
  });
}

/** Candidates worth re-measuring now, best first. */
function probeOrder(cur: CurrentSource, cands: CtlCandidate[], state: CtlState, now: number, everyMs: number, unhealthy: boolean): string[] {
  const age = (c: CtlCandidate) => {
    const at = c.kind === 'http' ? c.http?.at : c.swarm?.at;
    return at == null ? Infinity : now - at;
  };
  const list = cands.filter((c) => c.key !== cur.key && c.lang === cur.lang && c.probeable && !c.web && !state.bad[c.key] && age(c) >= everyMs);
  const sorted = [...list].sort((a, b) => {
    if (unhealthy) {
      // Smoother first: direct links before swarms (when the current one is a torrent), lighter bitrates first.
      if (a.kind !== b.kind && cur.kind === 'torrent') return a.kind === 'http' ? -1 : 1;
      return a.bitrateMbps - b.bitrateMbps;
    }
    // Upgrade candidates first: higher resolution, then quality.
    return b.resolution - a.resolution || b.quality - a.quality;
  });
  return sorted.map((c) => c.key);
}

// ---------- the step ----------

const hold = (state: CtlState, why: string, reprobe: string[] = []): CtlStep => ({ state, action: { type: 'hold', why }, reprobe });

/** One decision. Pure: same input, same output. */
export function step(prev: CtlState, input: CtlInput): CtlStep {
  const { now, current: cur, playback: p, candidates, settings } = input;
  if (!cur) return hold(prev, 'no-source');
  let state = prev;

  // 1. Another work under the same title: dropped like a broken source, whatever the settings.
  if (state.durationChecked !== cur.key && p.duration > 0 && Number.isFinite(p.duration)) {
    state = { ...state, durationChecked: cur.key };
    const v = input.currentExempt ? 'unknown' : durationVerdict(p.duration, input.episode, input.currentEpisodes);
    if (v === 'too-long' || v === 'too-short') {
      const others = candidates.some((c) => c.key !== cur.key && !state.bad[c.key] && !c.web);
      if (others) {
        state = { ...state, bad: { ...state.bad, [cur.key]: 'wrong-duration' }, preparing: null };
        return { state, action: { type: 'drop', key: cur.key, reason: 'wrong-duration' }, reprobe: [] };
      }
    }
  }

  if (!settings.auto) return hold(state, 'off');
  const health = assessHealth(cur, p, now);
  const bp = backgroundProbes(settings.net);
  const slowStart = !p.started && p.sinceLoadMs >= (cur.kind === 'torrent' ? SLOW_START_TORRENT_MS : SLOW_START_HTTP_MS);
  const unhealthy = health.level !== 'ok' || slowStart;

  // Background re-probes of the alternatives, within the network budget.
  const probes = (): string[] => {
    if (!bp.count || (bp.onlyWhenUnhealthy && !unhealthy)) return [];
    if (state.preparing?.reason === 'upgrade') return [];
    const every = unhealthy ? URGENT_PROBE_MS : bp.everyMs;
    if (state.lastProbeRound != null && now - state.lastProbeRound < every) return [];
    const keys = probeOrder(cur, candidates, state, now, every, unhealthy).slice(0, bp.count + (unhealthy ? 1 : 0));
    if (keys.length) state = { ...state, lastProbeRound: now };
    return keys;
  };
  /** Hold, with this round's re-probes (computed first: they update `state`). */
  const wait = (why: string): CtlStep => {
    const r = probes();
    return hold(state, why, r);
  };
  const canSwitchMore = state.switches < MAX_SWITCHES;
  const markLeft = (reason: SwitchReason) => ({ ...state.bad, [cur.key]: reason });

  // 2. No first frame for too long: the next credible source, at once.
  if (slowStart && canSwitchMore) {
    const pick = pickStable(cur, candidates, state, now);
    if (pick) {
      state = { ...state, bad: markLeft('slow-start'), preparing: null };
      return { state, action: { type: 'switch', key: pick.key, reason: 'slow-start' }, reprobe: [] };
    }
    return wait('slow-start-no-alternative');
  }

  // 3. A warm-up in progress.
  const prep = state.preparing;
  if (prep) {
    const target = candidates.find((c) => c.key === prep.key);
    if (!target || state.bad[prep.key]) {
      state = { ...state, preparing: null };
      return { state, action: { type: 'cancel', key: prep.key, why: 'gone' }, reprobe: [] };
    }
    if (prep.reason === 'upgrade') {
      if (health.level !== 'ok') {
        state = { ...state, preparing: null };
        return { state, action: { type: 'cancel', key: prep.key, why: 'unhealthy' }, reprobe: [] };
      }
      if (now - prep.since > UPGRADE_PREPARE_MAX_MS) {
        state = { ...state, preparing: null, noUpgrade: [...state.noUpgrade, prep.key] };
        return { state, action: { type: 'cancel', key: prep.key, why: 'timeout' }, reprobe: [] };
      }
      return hold(state, 'preparing');
    }
    // Stability warm-up: a new stall, a critical state or a slow warm-up → switch now.
    const newStall = p.stalls.length > prep.stallsAtStart;
    if (health.level === 'critical' || newStall || now - prep.since > STABLE_PREPARE_MAX_MS) {
      state = { ...state, preparing: null, bad: markLeft(prep.reason) };
      return { state, action: { type: 'switch', key: prep.key, reason: prep.reason }, reprobe: [] };
    }
    return wait('preparing');
  }

  // 4. Stability: leave a source that stalls (or is about to) for a smoother one.
  if (unhealthy && health.level !== 'ok' && canSwitchMore) {
    const critical = health.level === 'critical';
    const since = state.lastSwitchAt == null ? Infinity : now - state.lastSwitchAt;
    const dwellOk = critical || p.sincePlayMs >= STABLE_DWELL_MS;
    const coolOk = since >= (critical ? CRITICAL_COOLDOWN_MS : STABLE_COOLDOWN_MS);
    if (!dwellOk || !coolOk) return wait('stability-wait');
    const pick = pickStable(cur, candidates, state, now);
    if (!pick) return wait('no-better');
    // "Risk" (draining, slow download) only moves to a comfortable source.
    if (health.level === 'risk' && headroom(pick) < STABLE_HEADROOM) return wait('risk-no-comfortable');
    const reason: SwitchReason = health.why === 'weak-swarm' ? 'weak-swarm' : 'stall';
    const hard =
      critical ||
      p.stalledNowMs > 0 ||
      (p.bufferAhead >= 0 && p.bufferAhead < HARD_BUFFER_S) ||
      // Torrent target: never two downloads at once (the old one is released as the new one starts).
      pick.kind === 'torrent' ||
      state.seamlessFailed.includes(pick.key);
    if (hard) {
      state = { ...state, bad: markLeft(reason) };
      return { state, action: { type: 'switch', key: pick.key, reason }, reprobe: [] };
    }
    state = { ...state, preparing: { key: pick.key, reason, since: now, stallsAtStart: p.stalls.length } };
    return { state, action: { type: 'prepare', key: pick.key, reason }, reprobe: [] };
  }

  // 5. Upgrade on a good network: higher quality, seamlessly.
  const cap = Math.min(upgradeCap(settings.net), settings.deviceMaxRes);
  const lastStall = p.stalls.length ? p.stalls[p.stalls.length - 1].at : -Infinity;
  const remaining = p.duration > 0 ? p.duration - p.position : Infinity;
  const since = state.lastSwitchAt == null ? Infinity : now - state.lastSwitchAt;
  const cooldown = state.lastSwitchReason && state.lastSwitchReason !== 'upgrade' ? UPGRADE_AFTER_STABILITY_MS : UPGRADE_COOLDOWN_MS;
  const upgradeBlocker = !canSwitchMore
    ? 'max-switches'
    : cap <= cur.resolution
      ? 'cap'
      : health.level !== 'ok'
        ? 'unhealthy'
        : !p.started || !p.playing || p.busy || p.external
          ? 'not-playing'
          : p.sincePlayMs < UPGRADE_DWELL_MS
            ? 'dwell'
            : since < cooldown
              ? 'cooldown'
              : now - lastStall < UPGRADE_CLEAN_MS
                ? 'recent-stall'
                : remaining < UPGRADE_MIN_REMAINING_S
                  ? 'near-end'
                  : null;
  if (!upgradeBlocker) {
    const pick = pickUpgradeTarget(cur, candidates, state, now, cap);
    if (pick) {
      state = { ...state, preparing: { key: pick.key, reason: 'upgrade', since: now, stallsAtStart: p.stalls.length } };
      return { state, action: { type: 'prepare', key: pick.key, reason: 'upgrade' }, reprobe: [] };
    }
  }
  return wait(upgradeBlocker ?? 'nothing-better');
}

// ---------- events from the wiring ----------

/** The player now plays `key` (seamless swap done, or hard switch loaded). */
export function switched(s: CtlState, key: string, reason: SwitchReason, now: number): CtlState {
  return { ...s, preparing: null, lastSwitchAt: now, lastSwitchReason: reason, switches: s.switches + 1, durationChecked: s.durationChecked === key ? key : null };
}

/** The warm-up of `key` failed (stalled, error, other engine, timeline mismatch). */
export function prepareFailed(s: CtlState, key: string, reason: SwitchReason): CtlState {
  const base = { ...s, preparing: s.preparing?.key === key ? null : s.preparing };
  if (reason === 'upgrade') return { ...base, noUpgrade: s.noUpgrade.includes(key) ? s.noUpgrade : [...s.noUpgrade, key] };
  return { ...base, seamlessFailed: s.seamlessFailed.includes(key) ? s.seamlessFailed : [...s.seamlessFailed, key] };
}

/** `key` failed to play (player error, resolution error): never a target again this episode. */
export function failed(s: CtlState, key: string): CtlState {
  return s.bad[key] ? s : { ...s, bad: { ...s.bad, [key]: 'failed' }, preparing: s.preparing?.key === key ? null : s.preparing };
}

// ---------- labels ----------

const res = (r: number) => (r >= 2160 ? '2160p' : r ? `${r}p` : '?');

/** Discreet toast after a switch ("Qualité améliorée · 1080p → 2160p", "Source plus stable"). */
export function switchToast(reason: SwitchReason, fromRes: number, toRes: number): string {
  if (reason === 'upgrade') return `Qualité améliorée · ${res(fromRes)} → ${res(toRes)}`;
  if (reason === 'wrong-duration') return 'Mauvaise vidéo écartée · autre source';
  if (reason === 'slow-start') return 'Source plus rapide';
  return 'Source plus stable';
}
