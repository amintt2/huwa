// Network awareness: offline banner, and the "Wi-Fi only" streaming rule.
import { NetworkStateType, useNetworkState } from 'expo-network';

import type { RaceBudget } from '@/addons/race-runner';

import { useSettings } from './settings';

/** `false` only when we know for sure there is no connection (unknown ⇒ assume online). */
export function useOnline(): boolean {
  const net = useNetworkState();
  if (net.type === NetworkStateType.NONE) return false;
  if (net.isConnected === false) return false;
  if (net.isInternetReachable === false) return false;
  return true;
}

const UNMETERED = new Set([NetworkStateType.WIFI, NetworkStateType.ETHERNET]);

export type StreamPolicy = { allowed: boolean; reason?: 'offline' | 'wifi-only' };

/**
 * Should a stream start right now? Players call this before loading a remote source.
 * Downloads already on the device are not concerned.
 */
export function useStreamPolicy(): StreamPolicy {
  const { wifiOnly } = useSettings();
  const net = useNetworkState();
  if (net.type === NetworkStateType.NONE || net.isConnected === false) return { allowed: false, reason: 'offline' };
  // Web and unknown types cannot tell Wi-Fi from cellular: don't block there.
  if (wifiOnly && net.type && net.type !== NetworkStateType.UNKNOWN && !UNMETERED.has(net.type)) {
    return { allowed: false, reason: 'wifi-only' };
  }
  return { allowed: true };
}

const NO_RACE: RaceBudget = { max: 0, concurrency: 0, bytes: 0, timeoutMs: 0 };
/** Wi-Fi / Ethernet: 6 links × 256 KiB at most (≈1.5 MB per episode), 3 at a time. */
const RACE_UNMETERED: RaceBudget = { max: 6, concurrency: 3, bytes: 256 * 1024, timeoutMs: 8000 };
/** Cellular: half the probe size, 3 links, 2 at a time. */
const RACE_METERED: RaceBudget = { max: 3, concurrency: 2, bytes: 128 * 1024, timeoutMs: 8000 };

/**
 * How much the source race may measure on this connection: nothing when streaming is not
 * allowed (offline, "Wi-Fi seulement" on cellular), less on cellular.
 */
export function useRaceBudget(): RaceBudget {
  const policy = useStreamPolicy();
  const net = useNetworkState();
  if (!policy.allowed) return NO_RACE;
  if (net.type === NetworkStateType.CELLULAR) return RACE_METERED;
  return RACE_UNMETERED;
}
