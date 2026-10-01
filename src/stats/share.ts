// "Comparer avec la communauté" (opt-in, OFF by default). At most once a week, a coarse noisy
// aggregate of the past week's starts (./community.ts) is published in the public stats room of
// the P2P network by a throwaway writer — never with the identity. The network figures are read
// back from the same rooms and shown only above the k-anonymity threshold.
import { getRandomBytes } from 'expo-crypto';
import { useEffect, useSyncExternalStore } from 'react';

import { getP2P, p2pBackend } from '@/p2p';

import { buildContribution, WEEK_MS, type CommunityStats } from './community';
import { getStats, markShared, statsReady, useStats } from './store';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Uniform [0, 1) from the system CSPRNG (the noise must not be predictable). */
function cryptoRand(): () => number {
  let buf = getRandomBytes(256);
  let i = 0;
  return () => {
    if (i + 4 > buf.length) {
      buf = getRandomBytes(256);
      i = 0;
    }
    const v = ((buf[i] << 24) >>> 0) + (buf[i + 1] << 16) + (buf[i + 2] << 8) + buf[i + 3];
    i += 4;
    return v / 2 ** 32;
  };
}

export type ShareResult = 'sent' | 'not-enough' | 'too-soon' | 'off' | 'unavailable';

/** Publishes this week's contribution if allowed and due. */
export async function shareNow(nowMs = Date.now()): Promise<ShareResult> {
  await statsReady;
  const s = getStats();
  if (!s.community) return 'off';
  if (nowMs - s.lastShared < WEEK_MS) return 'too-soon';
  if (p2pBackend() !== 'bare') return 'unavailable';
  const since = Math.max(s.lastShared, nowMs - WEEK_MS);
  const c = buildContribution(s.events.filter((e) => e.at > since), hex(getRandomBytes(16)), cryptoRand());
  if (!c) return 'not-enough';
  try {
    await getP2P().contributeStats(c);
  } catch {
    return 'unavailable';
  }
  markShared(nowMs);
  return 'sent';
}

let pending: ReturnType<typeof setTimeout> | undefined;

/**
 * After a playback session: if a contribution is due, send it a few random minutes later (so its
 * time says nothing about when an episode was watched).
 */
export function scheduleShare() {
  const s = getStats();
  if (pending || !s.community || Date.now() - s.lastShared < WEEK_MS) return;
  const delay = 60_000 + Math.floor(cryptoRand()() * 4 * 60_000);
  pending = setTimeout(() => {
    pending = undefined;
    shareNow().catch(() => {});
  }, delay);
}

// ---------- reading the network figures ----------

export type CommunityState = { loading: boolean; data: CommunityStats | null; at: number; error?: string };

const CACHE_MS = 10 * 60_000;
let community: CommunityState = { loading: false, data: null, at: 0 };
const listeners = new Set<() => void>();
const emit = (next: CommunityState) => {
  community = next;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => community;

/** Fetches the network sums (kept 10 min unless `force`). */
export function loadCommunity(force = false) {
  if (community.loading || (!force && community.at && Date.now() - community.at < CACHE_MS)) return;
  emit({ ...community, loading: true, error: undefined });
  getP2P()
    .communityStats()
    .then((data) => emit({ loading: false, data, at: Date.now() }))
    .catch((e: unknown) => emit({ ...community, loading: false, at: Date.now(), error: e instanceof Error ? e.message : String(e) }));
}

/** Network sums, only fetched while the comparison is switched on. */
export function useCommunityStats(): CommunityState & { refresh: () => void } {
  const on = useStats((s) => s.community);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (on) loadCommunity();
  }, [on]);
  return { ...state, refresh: () => loadCommunity(true) };
}
