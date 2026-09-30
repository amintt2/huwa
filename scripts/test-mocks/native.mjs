// In-memory stand-ins for the native modules used by src/p2p/local.ts, so the local
// P2P implementation can run under `node --test`.
import { randomBytes } from 'node:crypto';

const mem = new Map();
export const AsyncStorage = {
  getItem: async (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: async (k, v) => void mem.set(k, String(v)),
  removeItem: async (k) => void mem.delete(k),
  clear: async () => mem.clear(),
};

const secure = new Map();
export const SecureStore = {
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: async (k) => (secure.has(k) ? secure.get(k) : null),
  setItemAsync: async (k, v) => void secure.set(k, v),
  deleteItemAsync: async (k) => void secure.delete(k),
};

export const Crypto = { getRandomBytes: (n) => new Uint8Array(randomBytes(n)) };
export const Device = { deviceName: 'iPhone de test', modelName: 'iPhone' };
export const ReactNative = { Platform: { OS: 'ios' } };

export function resetNative() {
  mem.clear();
  secure.clear();
}
