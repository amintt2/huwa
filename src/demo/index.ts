// Demo mode wiring. Imported first by the root layout: when `-HuwaDemo 1` is passed, storage
// and Keychain reads are served from an in-memory copy of the demo seed, and nothing is
// written to the device. Without the flag this module does nothing.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { secure } from '@/p2p/secure';

import { isDemo } from './flags';
import { demoLists, demoP2PDB, demoSecrets, demoSettings, demoStoreState } from './seed';

export { demoLang, demoRoute, isDemo } from './flags';

function install() {
  const now = Date.now();
  const mem = new Map<string, string>([
    ['huwa/settings/v1', JSON.stringify(demoSettings())],
    ['huwa/state/v1', JSON.stringify(demoStoreState(now))],
    ['huwa/lists/v1', JSON.stringify(demoLists(now))],
    ['huwa/p2p/local/v1', JSON.stringify(demoP2PDB(now))],
    ['huwa/addon-prefs/v1', JSON.stringify({ preferredQuality: 1080, legalAccepted: true })],
    ['huwa/cloud-backup/v1', JSON.stringify({ enabled: true })],
  ]);
  const secrets = new Map(Object.entries(demoSecrets()));

  const store = AsyncStorage as unknown as Record<string, unknown>;
  const get = async (k: string) => mem.get(k) ?? null;
  const set = async (k: string, v: string) => {
    mem.set(k, v);
  };
  const del = async (k: string) => {
    mem.delete(k);
  };
  store.getItem = get;
  store.setItem = set;
  store.removeItem = del;
  store.mergeItem = async (k: string, v: string) => mem.set(k, JSON.stringify({ ...JSON.parse(mem.get(k) ?? '{}'), ...JSON.parse(v) }));
  store.getAllKeys = async () => [...mem.keys()];
  store.multiGet = async (keys: string[]) => keys.map((k) => [k, mem.get(k) ?? null]);
  store.multiSet = async (pairs: [string, string][]) => pairs.forEach(([k, v]) => mem.set(k, v));
  store.multiRemove = async (keys: string[]) => keys.forEach((k) => mem.delete(k));
  store.clear = async () => mem.clear();

  secure.get = async (k: string) => secrets.get(k) ?? null;
  secure.set = async (k: string, v: string) => {
    secrets.set(k, v);
  };
  secure.del = async (k: string) => {
    secrets.delete(k);
  };
}

if (isDemo) install();
