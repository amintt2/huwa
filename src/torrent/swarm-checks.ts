// Background swarm checks while an episode plays (source controller, addons/source-controller.ts):
// the same engine probes as the start race (metadata + answering peers, never a piece), a few at a
// time, results kept per info hash with their time. The probes run in the engine; this only starts,
// polls and cancels them.
import { useSyncExternalStore } from 'react';

import { probeCancel, probeStart, probeStatuses } from './index';
import { MIN_CONNECTED } from './peer-race';
import type { ProbeStatus } from './types';

export type SwarmCheck = { connected: number; healthy: boolean; local: boolean; failed: boolean; at: number; fileIdx?: number | null };
export type SwarmTarget = { infoHash: string; sources?: string[]; name?: string; fileIdx?: number | null; filename?: string; episode?: number };

/** Longer than the start race's 3 s: nobody waits on these. */
const CHECK_TIMEOUT_MS = 6000;
const POLL_MS = 500;
const FINAL = new Set(['healthy', 'weak', 'noFile', 'failed', 'cancelled']);

const results = new Map<string, SwarmCheck>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

const toCheck = (st: ProbeStatus): SwarmCheck => ({
  connected: st.connected,
  healthy: st.state === 'healthy' || st.connected >= MIN_CONNECTED,
  local: st.local,
  failed: st.state === 'failed' || st.state === 'noFile',
  at: Date.now(),
  fileIdx: st.fileIdx,
});

export const swarmCheck = (hash: string) => results.get(hash.toLowerCase());

/** Starts a check of each target not already being checked. Fire and forget. */
export function checkSwarms(targets: SwarmTarget[]) {
  for (const t of targets) {
    const hash = t.infoHash.toLowerCase();
    if (inflight.has(hash)) continue;
    inflight.add(hash);
    void run(hash, t).finally(() => inflight.delete(hash));
  }
}

async function run(hash: string, t: SwarmTarget) {
  let id: number | null = null;
  try {
    const st = await probeStart({
      infoHash: hash,
      sources: t.sources,
      name: t.name,
      fileIdx: t.fileIdx,
      filename: t.filename,
      episode: t.episode,
      timeoutMs: CHECK_TIMEOUT_MS,
      minPeers: MIN_CONNECTED,
    });
    id = st.id;
    const until = Date.now() + CHECK_TIMEOUT_MS + 1000;
    let last: ProbeStatus = st;
    while (!FINAL.has(last.state) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const list = await probeStatuses([id]).catch(() => null);
      const next = list?.find((x) => x.id === id);
      if (!next) break;
      last = next;
    }
    results.set(hash, toCheck(last));
  } catch {
    results.set(hash, { connected: 0, healthy: false, local: false, failed: true, at: Date.now() });
  } finally {
    if (id != null) void probeCancel([id]).catch(() => {});
    emit();
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getVersion = () => version;

/** Re-renders when a check ends. */
export function useSwarmChecks(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}
