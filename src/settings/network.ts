// Network awareness: offline banner, the "Wi-Fi only" streaming rule, and the budgets of the
// network class (./network-budget.ts: Wi-Fi, cellular, Low Data Mode / "économie"; read from
// expo-network + iOS NWPath in ./net-path.ts).
import { NetworkStateType, useNetworkState } from 'expo-network';

import type { RaceBudget } from '@/addons/race-runner';

import { allowsPrewarm, raceBudget, torrentProbeBudgetFor, type NetClass, type TorrentProbeBudget } from './network-budget';
import { useNetClass } from './net-path';

export type { TorrentProbeBudget, NetClass } from './network-budget';
export { useNetClass, currentNetClass } from './net-path';

/** `false` only when we know for sure there is no connection (unknown ⇒ assume online). */
export function useOnline(): boolean {
  const net = useNetworkState();
  if (net.type === NetworkStateType.NONE) return false;
  if (net.isConnected === false) return false;
  if (net.isInternetReachable === false) return false;
  return true;
}

export type StreamPolicy = { allowed: boolean; reason?: 'offline' | 'wifi-only' };

const policyOf = (c: NetClass): StreamPolicy =>
  c === 'offline' ? { allowed: false, reason: 'offline' } : c === 'blocked' ? { allowed: false, reason: 'wifi-only' } : { allowed: true };

/**
 * Should a stream start right now? Players call this before loading a remote source.
 * Downloads already on the device are not concerned.
 */
export function useStreamPolicy(): StreamPolicy {
  return policyOf(useNetClass());
}

/** Wi-Fi / Ethernet, or cellular in "illimité" (the class `unmetered`). */
export function useUnmetered(): boolean {
  return useNetClass() === 'unmetered';
}

/**
 * Pre-buffering before the user presses Play (pre-search warm player, torrent pre-warm): on an
 * unmetered network and on cellular without Low Data Mode ("équilibré"), where a fast start is
 * worth a few MB.
 */
export function usePrewarm(): boolean {
  return allowsPrewarm(useNetClass());
}

/** How much the source race may measure on this connection (nothing when streaming is not allowed). */
export function useRaceBudget(): RaceBudget {
  return raceBudget(useNetClass());
}

/**
 * Torrents the on-device engine may probe before one is streamed ("course des torrents",
 * src/torrent/peer-race.ts): metadata and peers only, never a piece. None when streaming is not
 * allowed; the torrent engine's own "Wi-Fi only" setting is checked by `canProbeTorrents`.
 */
export function useTorrentProbeBudget(): TorrentProbeBudget {
  return torrentProbeBudgetFor(useNetClass());
}
