// Node resolve/load hooks for `node --test`: lets TypeScript sources keep Metro-style
// extensionless imports (`./rank`) and the `@/` alias while Node strips the types, and
// swaps the few native modules used by the P2P layer for in-memory mocks.
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = new URL('../src/', import.meta.url);
const CANDIDATES = ['', '.ts', '.tsx', '/index.ts'];

const MOCKS = {
  '@react-native-async-storage/async-storage': 'export default (await import(NATIVE)).AsyncStorage;',
  'expo-secure-store': 'const m = (await import(NATIVE)).SecureStore; export const { WHEN_UNLOCKED_THIS_DEVICE_ONLY, getItemAsync, setItemAsync, deleteItemAsync } = m;',
  'expo-crypto': 'export const { getRandomBytes } = (await import(NATIVE)).Crypto;',
  'expo-device': 'export const { deviceName, modelName } = (await import(NATIVE)).Device;',
  'react-native': 'export const { Platform } = (await import(NATIVE)).ReactNative;',
};
const NATIVE = new URL('./test-mocks/native.mjs', import.meta.url).href;

function tryFile(base) {
  for (const ext of CANDIDATES) {
    const url = new URL(base + ext);
    const p = fileURLToPath(url);
    if (existsSync(p) && statSync(p).isFile()) return url.href;
  }
  return undefined;
}

export async function resolve(specifier, context, next) {
  if (specifier in MOCKS) return { url: `huwa-mock:${specifier}`, shortCircuit: true };
  if (specifier.startsWith('@/')) {
    const hit = tryFile(new URL(specifier.slice(2), SRC).href);
    if (hit) return { url: hit, shortCircuit: true };
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    const hit = tryFile(new URL(specifier, context.parentURL).href);
    if (hit) return { url: hit, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith('huwa-mock:')) {
    const source = `const NATIVE = ${JSON.stringify(NATIVE)};\n${MOCKS[url.slice('huwa-mock:'.length)]}`;
    return { format: 'module', source, shortCircuit: true };
  }
  return next(url, context);
}
