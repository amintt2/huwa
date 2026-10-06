// "Course des torrents": decision rules for the on-device engine (pure, no React / native here).
// When the only candidates are torrents the engine would download itself (nothing cached by a
// debrid service, no direct link), the best few are probed in parallel by the native engine
// (native/huwa-torrent-core/src/probe.rs: metadata + peers answering a handshake, never a piece)
// and the stream starts on the first healthy swarm instead of waiting on one torrent at a time.
// The runner (./use-peer-race.ts) starts / polls / cancels the probes; use-source.ts plugs the
// decision in place of the HTTP race.
import type { ProbeState, ProbeStatus } from './types';

// Time budget (time to first frame: < 2 s for a popular title, < 5 s for any): the race commits
// as soon as a swarm is healthy (popular: ~0.5 s), at `SOFT_COMMIT_MS` on the best swarm with at
// least one answering peer, at `PEER_RACE_DEADLINE_MS` on anything playable. Then the stream needs
// ~1–2.5 s to its first frame (native/huwa-torrent-core/src/startup_sim.rs, which mirrors these
// constants; the timeline is tested in __tests__/race-timeline.test.ts).

/** Answering peers that make a swarm "healthy" (sent to the engine as `minPeers`). */
export const MIN_CONNECTED = 3;
/** Engine-side probe deadline (the race usually cancels the probes before). */
export const PROBE_TIMEOUT_MS = 3000;
/** No healthy swarm by then: the best one with an answering peer wins. */
export const SOFT_COMMIT_MS = 1500;
/** Hard deadline: the best playable swarm (metadata + file), else the plain ranking. */
export const PEER_RACE_DEADLINE_MS = 2500;
/** Every candidate still looks weak by then: more are probed (see `shouldWiden`). */
export const WIDEN_AFTER_MS = 800;
/** Engine probes polled this often: a healthy swarm is seen at most this long after the engine. */
export const PEER_POLL_MS = 200;
/**
 * A healthy torrent in a worse language waits this long for a better-language one still
 * probing (never past the deadline).
 */
export const LANG_GRACE_MS = 500;

/** A race decided for an episode (pre-search or an earlier visit): winner key, when, its file. */
export type PeerWin = { key: string; at: number; fileIdx?: number | null };
/** A decided race is reused this long (the engine keeps the probe's metadata and peers 20 min). */
export const PEER_WIN_TTL_MS = 3 * 60_000;

/**
 * The tap reuses the race decided a moment ago for the same episode (pre-search on the detail
 * page) instead of racing again: when it is recent, its winner is still a candidate, and no
 * source failed since (a failure starts a new round).
 */
export function reusableWin(win: PeerWin | undefined, nowMs: number, candidateKeys: string[], failed: number): PeerWin | undefined {
  if (!win || failed > 0 || nowMs - win.at >= PEER_WIN_TTL_MS || nowMs < win.at) return undefined;
  return candidateKeys.includes(win.key) ? win : undefined;
}

/** What the decision needs from a probe (+ when it ended, ms since the race started). */
export type PeerProbe = Pick<ProbeStatus, 'state' | 'peers' | 'connected' | 'local'> & {
  fileIdx?: number | null;
  doneAtMs?: number;
};

/** In preference order (language, then quality / seeders, as sorted by use-source). */
export type PeerCandidate = { key: string; lang: number; probe?: PeerProbe };

export type PeerDecision =
  | { key: string; why: 'local' | 'healthy' | 'best' }
  | { key: null; waitMs: number }
  /** Nothing usable came out of the probes: the caller falls back to the plain ranking. */
  | { key: null; exhausted: true };

const PENDING: ProbeState[] = ['queued', 'resolving'];
export const isPending = (p: PeerProbe | undefined) => !!p && PENDING.includes(p.state);
/**
 * Has the metadata and the wanted file (playable, maybe slowly). A probe still resolving has them
 * once the engine reported the file it found (`fileIdx`).
 */
const playable = (p: PeerProbe | undefined) =>
  !!p && (p.state === 'healthy' || p.state === 'weak' || p.local || (p.state === 'resolving' && p.fileIdx != null));

/**
 * A list of stream keys as one string (React dependency). Keys embed the addon's name / title,
 * which hold line breaks ("Torrentio\n1080p"): never join them on '\n'.
 */
export const packKeys = (keys: string[]) => (keys.length ? JSON.stringify(keys) : '');
export const unpackKeys = (packed: string): string[] => (packed ? (JSON.parse(packed) as string[]) : []);

/** Keys to probe: the first `n` candidates (already in preference order: language first). */
export function probeTargets<T extends { key: string }>(ordered: T[], n: number): string[] {
  return n > 0 ? ordered.slice(0, n).map((c) => c.key) : [];
}

/** Lower language score, then the caller's order. */
function first(cands: PeerCandidate[]): PeerCandidate | undefined {
  let best: PeerCandidate | undefined;
  for (const c of cands) if (!best || c.lang < best.lang) best = c;
  return best;
}

/** Time until the next moment the decision can change on its own (widening, soft, hard deadline). */
function nextCheckpoint(elapsedMs: number, deadlineMs: number, softMs: number) {
  const next = [WIDEN_AFTER_MS, softMs, deadlineMs].filter((t) => t > elapsedMs);
  return Math.max(50, (next.length ? Math.min(...next) : deadlineMs) - elapsedMs);
}

/** Best of slow swarms: language, answering peers, discovered peers, then the caller's order. */
function bestSlow(cands: PeerCandidate[]): PeerCandidate {
  return cands.reduce((a, b) => {
    if (b.lang !== a.lang) return b.lang < a.lang ? b : a;
    if (b.probe!.connected !== a.probe!.connected) return b.probe!.connected > a.probe!.connected ? b : a;
    if (b.probe!.peers !== a.probe!.peers) return b.probe!.peers > a.probe!.peers ? b : a;
    return a;
  });
}

export function decidePeerRace(
  cands: PeerCandidate[],
  elapsedMs: number,
  deadlineMs = PEER_RACE_DEADLINE_MS,
  softMs = SOFT_COMMIT_MS,
): PeerDecision {
  const probed = cands.filter((c) => c.probe && c.probe.state !== 'cancelled');
  if (!probed.length) return cands.some((c) => c.probe) ? { key: null, exhausted: true } : { key: null, waitMs: nextCheckpoint(elapsedMs, deadlineMs, softMs) };

  // Already complete on the device: nothing to wait for.
  const local = first(probed.filter((c) => c.probe!.local));
  if (local) return { key: local.key, why: 'local' };

  const pending = probed.filter((c) => isPending(c.probe));
  const late = elapsedMs >= deadlineMs;

  const healthy = probed.filter((c) => c.probe!.state === 'healthy');
  const best = first(healthy);
  if (best) {
    // A better language may still come in: short grace, bounded by the deadline.
    const better = pending.some((c) => c.lang < best.lang);
    const firstAt = Math.min(...healthy.filter((c) => c.lang === best.lang).map((c) => c.probe!.doneAtMs ?? elapsedMs));
    const until = Math.min(firstAt + LANG_GRACE_MS, deadlineMs);
    if (better && !late && elapsedMs < until) return { key: null, waitMs: Math.max(50, until - elapsedMs) };
    return { key: best.key, why: 'healthy' };
  }

  const weak = probed.filter((c) => playable(c.probe));
  // Soft deadline: no healthy swarm yet (obscure title), waiting longer rarely finds one and costs
  // the first frame. The best swarm that has the file and an answering peer wins.
  const answering = weak.filter((c) => c.probe!.connected > 0);
  if (pending.length && !late && elapsedMs >= softMs && answering.length) return { key: bestSlow(answering).key, why: 'best' };

  if (pending.length && !late) return { key: null, waitMs: nextCheckpoint(elapsedMs, deadlineMs, softMs) };

  // Deadline (or every probe done): the best of the slow ones.
  if (!weak.length) return { key: null, exhausted: true };
  return { key: bestSlow(weak).key, why: 'best' };
}

/**
 * Obscure titles: every candidate looks weak (no healthy swarm, fewer than `MIN_CONNECTED`
 * answering peers each) after `WIDEN_AFTER_MS`, or every probe already ended without a healthy
 * one. The race then probes more candidates (`TorrentProbeBudget.max`: packs, other qualities),
 * still committing by the same deadlines.
 */
export function shouldWiden(probes: (PeerProbe | undefined)[], elapsedMs: number): boolean {
  const list = probes.filter((p): p is PeerProbe => !!p && p.state !== 'cancelled');
  if (!list.length) return false;
  if (list.some((p) => p.state === 'healthy' || p.local || p.connected >= MIN_CONNECTED)) return false;
  return elapsedMs >= WIDEN_AFTER_MS || list.every((p) => !isPending(p));
}

/** Keys whose torrent does not contain the episode: never started. */
export const wrongTorrents = (probes: Record<string, PeerProbe | undefined>) =>
  Object.keys(probes).filter((k) => probes[k]?.state === 'noFile');

export type PeerVerdict = 'fast' | 'ok' | 'slow' | 'dead';

const pairs = (n: number) => `${n} pair${n > 1 ? 's' : ''}`;

/** Sources menu row: "12 pairs", "aucun pair", "recherche de pairs…". Null = nothing to show. */
export function peerLabel(p: PeerProbe | undefined): { label: string; speed?: PeerVerdict } | null {
  if (!p) return null;
  if (p.local) return { label: 'déjà sur l’appareil', speed: 'fast' };
  switch (p.state) {
    case 'queued':
      return { label: 'en attente…' };
    case 'resolving':
      return { label: p.connected ? `${pairs(p.connected)}…` : p.peers ? `${p.peers} trouvés…` : 'recherche de pairs…' };
    case 'healthy':
      return { label: pairs(p.connected), speed: 'fast' };
    case 'weak':
      return { label: p.connected ? pairs(p.connected) : 'aucun pair', speed: p.connected ? 'slow' : 'dead' };
    case 'noFile':
      return { label: 'épisode absent du torrent', speed: 'dead' };
    case 'failed':
      return { label: 'aucun pair', speed: 'dead' };
    case 'cancelled':
      // Stopped because another torrent won: show what it had found, if anything.
      return p.connected ? { label: pairs(p.connected) } : null;
  }
}
