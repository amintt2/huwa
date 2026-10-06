// "Course des torrents": decision rules for the on-device engine (pure, no React / native here).
// When the only candidates are torrents the engine would download itself (nothing cached by a
// debrid service, no direct link), the best few are probed in parallel by the native engine
// (native/huwa-torrent-core/src/probe.rs: metadata + peers answering a handshake, never a piece)
// and the stream starts on the first healthy swarm instead of waiting on one torrent at a time.
// The runner (./use-peer-race.ts) starts / polls / cancels the probes; use-source.ts plugs the
// decision in place of the HTTP race.
import type { ProbeState, ProbeStatus } from './types';

/** Answering peers that make a swarm "healthy" (sent to the engine as `minPeers`). */
export const MIN_CONNECTED = 3;
/** Engine-side probe deadline. */
export const PROBE_TIMEOUT_MS = 8000;
/** JS-side deadline: the engine's plus polling slack. */
export const PEER_RACE_DEADLINE_MS = PROBE_TIMEOUT_MS + 1000;
/**
 * A healthy torrent in a worse language waits this long for a better-language one still
 * probing (never past the deadline).
 */
export const LANG_GRACE_MS = 1500;

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
/** Has the metadata and the wanted file (playable, maybe slowly). */
const playable = (p: PeerProbe | undefined) => !!p && (p.state === 'healthy' || p.state === 'weak' || p.local);

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

export function decidePeerRace(cands: PeerCandidate[], elapsedMs: number, deadlineMs = PEER_RACE_DEADLINE_MS): PeerDecision {
  const probed = cands.filter((c) => c.probe && c.probe.state !== 'cancelled');
  if (!probed.length) return cands.some((c) => c.probe) ? { key: null, exhausted: true } : { key: null, waitMs: Math.max(50, deadlineMs - elapsedMs) };

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

  if (pending.length && !late) return { key: null, waitMs: Math.max(50, deadlineMs - elapsedMs) };

  // Deadline (or every probe done): the best of the slow ones — language, answering peers,
  // discovered peers, then the caller's order.
  const weak = probed.filter((c) => playable(c.probe));
  if (!weak.length) return { key: null, exhausted: true };
  const pick = weak.reduce((a, b) => {
    if (b.lang !== a.lang) return b.lang < a.lang ? b : a;
    if (b.probe!.connected !== a.probe!.connected) return b.probe!.connected > a.probe!.connected ? b : a;
    if (b.probe!.peers !== a.probe!.peers) return b.probe!.peers > a.probe!.peers ? b : a;
    return a;
  });
  return { key: pick.key, why: 'best' };
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
