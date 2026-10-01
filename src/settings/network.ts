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

/**
 * Wi-Fi / Ethernet (or a platform that cannot tell): pre-buffering a video before the user
 * presses Play is allowed only there.
 */
export function useUnmetered(): boolean {
  const policy = useStreamPolicy();
  const net = useNetworkState();
  if (!policy.allowed) return false;
  return net.type !== NetworkStateType.CELLULAR;
}

const NO_RACE: RaceBudget = { max: 0, concurrency: 0, bytes: 0, timeoutMs: 0 };
/**
 * Wi-Fi / Ethernet: every candidate at once (up to 10, ≈1.6 MB per episode). Testing in small
 * batches let dead links (often 5–8 s to fail) hold the slots, so good ones waited their turn.
 */
const RACE_UNMETERED: RaceBudget = { max: 10, concurrency: 10, bytes: 160 * 1024, timeoutMs: 5000 };
/** Cellular: 4 links, all at once, smaller probes. */
const RACE_METERED: RaceBudget = { max: 4, concurrency: 4, bytes: 96 * 1024, timeoutMs: 5000 };

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
