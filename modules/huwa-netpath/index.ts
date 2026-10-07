// Binding to the `HuwaNetPath` native module (./ios): NWPath cost flags. null on Android, web,
// in Expo Go and in builds made before this module existed (callers fall back to expo-network).
import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

export type NetPathInfo = {
  /** false until the first path update. */
  known: boolean;
  satisfied?: boolean;
  /** Cellular, or Wi-Fi through a phone's personal hotspot. */
  expensive?: boolean;
  /** Low Data Mode on this interface. */
  constrained?: boolean;
  wifi?: boolean;
  cellular?: boolean;
  wired?: boolean;
};

type Native = {
  current(): NetPathInfo;
  addListener(event: 'onChange', cb: (info: NetPathInfo) => void): EventSubscription;
};

export const HuwaNetPath = requireOptionalNativeModule<Native>('HuwaNetPath');
