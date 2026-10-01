// Addon answers kept on disk, so reopening an episode (or the app) shows its sources at once:
// stale-while-revalidate. An answer younger than REVALIDATE_MS is used as is; up to MAX_AGE_MS it
// is shown immediately and refreshed in the background; older ones are dropped.
// One AsyncStorage entry per addon request (`<addon base URL>|<type>/<id>`), plus a small index
// (request → time) for pruning (least recently written first, at most MAX_ENTRIES).
// Link measurements of the race are not stored here (see race-runner.ts, minutes-long TTL).
import AsyncStorage from '@react-native-async-storage/async-storage';

export const REVALIDATE_MS = 15 * 60e3;
export const MAX_AGE_MS = 6 * 3600e3;
export const MAX_ENTRIES = 80;

export type Freshness = 'fresh' | 'stale' | 'expired';

export function freshness(at: number, now = Date.now()): Freshness {
  const age = now - at;
  if (age < 0 || age >= MAX_AGE_MS) return 'expired';
  return age < REVALIDATE_MS ? 'fresh' : 'stale';
}

type Index = Record<string, number>;

/** Entries to delete: expired ones, then the oldest beyond `max`. */
export function entriesToDrop(index: Index, now = Date.now(), max = MAX_ENTRIES): string[] {
  const drop = Object.keys(index).filter((k) => freshness(index[k], now) === 'expired');
  const alive = Object.keys(index)
    .filter((k) => !drop.includes(k))
    .sort((a, b) => index[b] - index[a]);
  return [...drop, ...alive.slice(max)];
}

/** Short storage key for a request key (FNV-1a, 2 × 32 bits). */
export function storageKey(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return `huwa/streams/v1/${h1.toString(36)}${h2.toString(36)}`;
}

const INDEX_KEY = 'huwa/streams/v1#index';
let index: Index | null = null;
let indexLoad: Promise<Index> | null = null;
const mem = new Map<string, { at: number; items: unknown[] }>();

function loadIndex(): Promise<Index> {
  if (index) return Promise.resolve(index);
  indexLoad ??= AsyncStorage.getItem(INDEX_KEY)
    .then((raw) => (index = raw ? (JSON.parse(raw) as Index) : {}))
    .catch(() => (index = {}));
  return indexLoad;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveIndex() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (index) AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index)).catch(() => {});
  }, 400);
}

/** Cached answer for a request, unless expired. */
export async function readAnswer<T>(key: string): Promise<{ at: number; items: T[] } | undefined> {
  const idx = await loadIndex();
  const at = idx[key];
  if (at == null || freshness(at) === 'expired') return undefined;
  const hit = mem.get(key);
  if (hit && hit.at === at) return hit as { at: number; items: T[] };
  try {
    const raw = await AsyncStorage.getItem(storageKey(key));
    if (!raw) return undefined;
    const v = JSON.parse(raw) as { at: number; items: T[] };
    if (freshness(v.at) === 'expired') return undefined;
    mem.set(key, v);
    return v;
  } catch {
    return undefined;
  }
}

/** Stores an answer (only useful ones should be stored: an empty answer is not worth keeping). */
export async function writeAnswer<T>(key: string, items: T[]) {
  const idx = await loadIndex();
  const v = { at: Date.now(), items };
  mem.set(key, v);
  idx[key] = v.at;
  AsyncStorage.setItem(storageKey(key), JSON.stringify(v)).catch(() => {});
  const drop = entriesToDrop(idx);
  if (drop.length) {
    for (const k of drop) {
      delete idx[k];
      mem.delete(k);
    }
    for (const k of drop) AsyncStorage.removeItem(storageKey(k)).catch(() => {});
  }
  saveIndex();
}

/** Forget an answer (its links proved dead). */
export async function dropAnswer(key: string) {
  const idx = await loadIndex();
  if (!(key in idx)) return;
  delete idx[key];
  mem.delete(key);
  AsyncStorage.removeItem(storageKey(key)).catch(() => {});
  saveIndex();
}
