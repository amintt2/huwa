// Network awareness: offline banner, and the "Wi-Fi only" streaming rule.
import { NetworkStateType, useNetworkState } from 'expo-network';

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
