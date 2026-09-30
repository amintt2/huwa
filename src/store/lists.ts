// Custom lists (besides "Ma liste", which lives in the main store) and a per-series status.
// Kept in its own persisted slice so it can evolve independently from progress/comments.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState, useSyncExternalStore } from 'react';

export type WatchStatus = 'planned' | 'watching' | 'completed' | 'dropped';
export const WATCH_STATUSES: WatchStatus[] = ['planned', 'watching', 'completed', 'dropped'];

export type CustomList = { id: string; name: string; seriesIds: string[]; createdAt: number };

export type ListsState = {
  lists: CustomList[];
  status: Record<string, WatchStatus>;
};

export const LISTS_KEY = 'huwa/lists/v1';
const initial: ListsState = { lists: [], status: {} };

let state: ListsState = initial;
let hydrated = false;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function set(updater: (s: ListsState) => ListsState) {
  state = updater(state);
  listeners.forEach((l) => l());
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    AsyncStorage.setItem(LISTS_KEY, JSON.stringify(state)).catch(() => {});
  }, 300);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useLists<T>(selector: (s: ListsState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

export const getLists = () => state;

export async function hydrateLists(force = false) {
  if (hydrated && !force) return;
  try {
    const raw = await AsyncStorage.getItem(LISTS_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<ListsState>) : {};
    state = {
      lists: Array.isArray(v.lists) ? v.lists : [],
      status: v.status && typeof v.status === 'object' ? v.status : {},
    };
  } catch {
    state = initial;
  }
  hydrated = true;
  listeners.forEach((l) => l());
}

export function useListsHydrated() {
  const [ready, setReady] = useState(hydrated);
  useEffect(() => {
    if (!hydrated) hydrateLists().then(() => setReady(true));
  }, []);
  return ready;
}

// ---------- actions ----------

const newId = () => `l-${Date.now().toString(36)}-${Math.round(Math.random() * 1e6).toString(36)}`;

export function createList(name: string, seriesIds: string[] = []): string {
  const id = newId();
  const clean = name.trim().slice(0, 40) || 'Liste';
  set((s) => ({ ...s, lists: [...s.lists, { id, name: clean, seriesIds, createdAt: Date.now() }] }));
  return id;
}

export function renameList(id: string, name: string) {
  const clean = name.trim().slice(0, 40);
  if (!clean) return;
  set((s) => ({ ...s, lists: s.lists.map((l) => (l.id === id ? { ...l, name: clean } : l)) }));
}

export function deleteList(id: string) {
  set((s) => ({ ...s, lists: s.lists.filter((l) => l.id !== id) }));
}

export function toggleInList(listId: string, seriesId: string) {
  set((s) => ({
    ...s,
    lists: s.lists.map((l) =>
      l.id !== listId
        ? l
        : { ...l, seriesIds: l.seriesIds.includes(seriesId) ? l.seriesIds.filter((x) => x !== seriesId) : [seriesId, ...l.seriesIds] },
    ),
  }));
}

/** Merge ids into a list by name (creates it if missing). Used by the AniList import. */
export function upsertListByName(name: string, seriesIds: string[]) {
  const existing = state.lists.find((l) => l.name === name);
  if (!existing) return createList(name, seriesIds);
  set((s) => ({
    ...s,
    lists: s.lists.map((l) => (l.id === existing.id ? { ...l, seriesIds: [...new Set([...seriesIds, ...l.seriesIds])] } : l)),
  }));
  return existing.id;
}

export function setWatchStatus(seriesId: string, status: WatchStatus | null) {
  set((s) => {
    const next = { ...s.status };
    if (status) next[seriesId] = status;
    else delete next[seriesId];
    return { ...s, status: next };
  });
}

export function setWatchStatuses(entries: Record<string, WatchStatus>) {
  set((s) => ({ ...s, status: { ...s.status, ...entries } }));
}

export function resetLists() {
  set(() => initial);
}
