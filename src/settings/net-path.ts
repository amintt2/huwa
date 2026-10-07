// The network class right now (./network-budget.ts), from expo-network's interface type and iOS's
// NWPath cost flags (modules/huwa-netpath: `isExpensive`, `isConstrained` = Low Data Mode).
// A store (not only a hook) so non-React code (torrent engine calls) reads the same answer.
import { addNetworkStateListener, getNetworkStateAsync, NetworkStateType, type NetworkState } from 'expo-network';
import { useSyncExternalStore } from 'react';

import { HuwaNetPath, type NetPathInfo } from '../../modules/huwa-netpath';
import { classifyNetwork, type NetClass, type NetSignals } from './network-budget';
import { getSettings, useSettings } from './settings';

let net: Pick<NetworkState, 'type' | 'isConnected'> = { type: NetworkStateType.UNKNOWN, isConnected: true };
let path: NetPathInfo = readPath();
let version = 0;
const listeners = new Set<() => void>();
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

function readPath(): NetPathInfo {
  try {
    return HuwaNetPath?.current() ?? { known: false };
  } catch {
    return { known: false };
  }
}

let started = false;
function start() {
  if (started) return;
  started = true;
  getNetworkStateAsync()
    .then((s) => {
      net = s;
      emit();
    })
    .catch(() => {});
  addNetworkStateListener((s) => {
    net = s;
    path = readPath();
    emit();
  });
  try {
    HuwaNetPath?.addListener('onChange', (info) => {
      path = info;
      emit();
    });
  } catch {
    // module absent
  }
}

const TYPE: Partial<Record<NetworkStateType, NetSignals['type']>> = {
  [NetworkStateType.WIFI]: 'wifi',
  [NetworkStateType.ETHERNET]: 'ethernet',
  [NetworkStateType.CELLULAR]: 'cellular',
  [NetworkStateType.NONE]: 'none',
  [NetworkStateType.UNKNOWN]: 'unknown',
};

/** expo-network + NWPath → the pure classifier's input. */
export function netSignals(n: Pick<NetworkState, 'type' | 'isConnected'>, p: NetPathInfo): NetSignals {
  let type: NetSignals['type'] = n.type ? (TYPE[n.type] ?? 'other') : 'unknown';
  // NWPath is the more precise one when expo-network cannot tell.
  if (p.known && (type === 'unknown' || type === 'other')) type = p.wifi ? 'wifi' : p.wired ? 'ethernet' : p.cellular ? 'cellular' : type;
  return {
    type,
    connected: n.isConnected !== false && (!p.known || p.satisfied !== false),
    expensive: p.known ? p.expensive : undefined,
    constrained: p.known ? p.constrained : undefined,
  };
}

const subscribe = (l: () => void) => {
  start();
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getVersion = () => version;

/** Current class, outside React (torrent engine calls, warm players). */
export function currentNetClass(): NetClass {
  start();
  const s = getSettings();
  return classifyNetwork(netSignals(net, path), { wifiOnly: s.wifiOnly, cellularData: s.cellularData });
}

/** Current class; re-renders when the connection or the settings change. */
export function useNetClass(): NetClass {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const s = useSettings();
  return classifyNetwork(netSignals(net, path), { wifiOnly: s.wifiOnly, cellularData: s.cellularData });
}

/** For the stats: what the connection was (Low Data Mode included). */
export function netPathFlags(): { expensive?: boolean; constrained?: boolean } {
  return path.known ? { expensive: path.expensive, constrained: path.constrained } : {};
}
