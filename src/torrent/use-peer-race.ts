// Runner of the torrent race (rules in ./peer-race.ts): starts one engine probe per target while
// `active`, polls them, and cancels whatever still runs as soon as the race is over (decision
// made, source chosen by hand, screen left, other episode). Results are kept for the sources menu.
import { useEffect, useRef, useState } from 'react';

import { probeCancel, probeStart, probeStatuses } from './index';
import { MIN_CONNECTED, PEER_POLL_MS, PROBE_TIMEOUT_MS, type PeerProbe } from './peer-race';
import type { ProbeStatus } from './types';

export type PeerTarget = {
  key: string;
  infoHash: string;
  sources?: string[];
  name?: string;
  fileIdx?: number | null;
  filename?: string;
  episode?: number;
};

/** Monotonic clock of the race (`startedAt`, `doneAtMs`). */
export const peerClock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const now = peerClock;

const FINAL = new Set(['healthy', 'weak', 'noFile', 'failed', 'cancelled']);

const toProbe = (st: ProbeStatus, doneAtMs?: number): PeerProbe => ({
  state: st.state,
  peers: st.peers,
  connected: st.connected,
  local: st.local,
  fileIdx: st.fileIdx,
  doneAtMs,
});

/**
 * `scope` identifies the episode: when it changes everything is cancelled and forgotten.
 * `done(probes, startedAt)` tells when the race is decided: polling stops and the probes still
 * running are cancelled. Returns the probes by stream key and when the race started
 * (`peerClock` ms, null before).
 */
export function usePeerRace(
  scope: string,
  targets: PeerTarget[],
  on: boolean,
  done: (probes: Record<string, PeerProbe>, startedAt: number | null) => boolean,
) {
  const [state, setState] = useState<{ scope: string; probes: Record<string, PeerProbe>; startedAt: number | null }>({
    scope,
    probes: {},
    startedAt: null,
  });
  /** key → engine probe id (undefined while `probeStart` is in flight). */
  const ids = useRef(new Map<string, number | undefined>());
  const finished = useRef(new Set<string>());
  const startedAt = useRef<number | null>(null);
  const view = state.scope === scope ? state : { probes: {}, startedAt: null };
  const active = on && !done(view.probes, view.startedAt);
  const live = useRef({ scope, active });

  // Other episode or screen left: cancel and forget (state reset during render, refs in the effect).
  if (state.scope !== scope) setState({ scope, probes: {}, startedAt: null });
  useEffect(() => {
    const map = ids.current;
    const ended = finished.current;
    return () => {
      void probeCancel([...map.values()].filter((v): v is number => v != null)).catch(() => {});
      map.clear();
      ended.clear();
      startedAt.current = null;
    };
  }, [scope]);

  useEffect(() => {
    live.current = { scope, active };
  }, [scope, active]);

  const targetsKey = targets.map((t) => t.key).join('\n');

  // Start a probe for each new target; targets that left the top N are cancelled.
  useEffect(() => {
    if (!active) return;
    const wanted = new Set(targets.map((t) => t.key));
    const dropped = [...ids.current.entries()].filter(([k, id]) => !wanted.has(k) && id != null && !finished.current.has(k));
    if (dropped.length) {
      void probeCancel(dropped.map(([, id]) => id!)).catch(() => {});
      for (const [k] of dropped) finished.current.add(k);
      setState((s) => {
        const probes = { ...s.probes };
        for (const [k] of dropped) if (probes[k]) probes[k] = { ...probes[k], state: 'cancelled' };
        return { ...s, probes };
      });
    }
    for (const t of targets) {
      if (ids.current.has(t.key)) continue;
      ids.current.set(t.key, undefined);
      if (startedAt.current == null) startedAt.current = now();
      const at = startedAt.current;
      setState((s) => ({ ...s, startedAt: s.startedAt ?? at, probes: { ...s.probes, [t.key]: { state: 'queued', peers: 0, connected: 0, local: false } } }));
      const mine = scope;
      probeStart({
        infoHash: t.infoHash,
        sources: t.sources,
        name: t.name,
        fileIdx: t.fileIdx,
        filename: t.filename,
        episode: t.episode,
        timeoutMs: PROBE_TIMEOUT_MS,
        minPeers: MIN_CONNECTED,
      })
        .then((st) => {
          // The race ended (or the episode changed) while the call was in flight.
          if (live.current.scope !== mine || !live.current.active) {
            void probeCancel([st.id]).catch(() => {});
            return;
          }
          ids.current.set(t.key, st.id);
        })
        .catch(() => {
          if (live.current.scope !== mine) return;
          finished.current.add(t.key);
          setState((s) => ({ ...s, probes: { ...s.probes, [t.key]: { state: 'failed', peers: 0, connected: 0, local: false, doneAtMs: now() - at } } }));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsKey, active, scope]);

  // Poll while running; when the race stops, whatever still runs is cancelled.
  useEffect(() => {
    if (!active) {
      // Starts still in flight are cancelled by their own `then` (`live.active` is false).
      const running = [...ids.current.entries()].filter(([k]) => !finished.current.has(k));
      if (!running.length) return;
      void probeCancel(running.flatMap(([, id]) => (id != null ? [id] : []))).catch(() => {});
      for (const [k] of running) finished.current.add(k);
      setState((s) => {
        const probes = { ...s.probes };
        for (const [k] of running) if (probes[k] && !FINAL.has(probes[k].state)) probes[k] = { ...probes[k], state: 'cancelled' };
        return { ...s, probes };
      });
      return;
    }
    let stopped = false;
    const tick = async () => {
      const running = [...ids.current.entries()].filter(([k, id]) => id != null && !finished.current.has(k));
      if (!running.length) return;
      const byId = new Map(running.map(([k, id]) => [id!, k]));
      const list = await probeStatuses([...byId.keys()]).catch(() => null);
      if (stopped || !list) return;
      const at = startedAt.current ?? now();
      const updates: [string, PeerProbe][] = [];
      for (const st of list) {
        const k = byId.get(st.id);
        if (!k) continue;
        const final = FINAL.has(st.state);
        if (final) finished.current.add(k);
        updates.push([k, toProbe(st, final ? now() - at : undefined)]);
      }
      if (updates.length) setState((s) => ({ ...s, probes: { ...s.probes, ...Object.fromEntries(updates) } }));
    };
    const timer = setInterval(() => void tick(), PEER_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, scope]);

  return { probes: view.probes as Record<string, PeerProbe>, startedAt: view.startedAt, active };
}
