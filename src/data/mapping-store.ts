// Community state of the episode ↔ chapter mapping, per season: the leading proposal of each
// field and whether it is verified (src/social/consensus.ts). Persisted, so verified values are
// applied at the next launch before any peer is reached.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { refreshCatalog } from './catalog';
import type { MappingOverride, Range } from './mapping';

export type FieldState = {
  /** Leading value: last chapter (`end`) or the episode's range (`from`–`to`). */
  from?: number;
  to: number;
  /** Distinct authors behind the leading value. */
  confirmations: number;
  verified: boolean;
  /** Value key of my own active proposal on this field, if any. */
  mine?: string;
};

export type SeasonState = { end?: FieldState; eps?: Record<number, FieldState> };

const KEY = 'huwa/mapping/v1';

let states: Record<string, SeasonState> = {};
let version = 0;
const listeners = new Set<() => void>();
let hydrated: Promise<void> | null = null;

const overrideJson = (st: SeasonState | undefined) => JSON.stringify(toOverride(st) ?? null);

function toOverride(st: SeasonState | undefined): MappingOverride | undefined {
  if (!st) return undefined;
  const out: MappingOverride = {};
  if (st.end?.verified) out.end = st.end.to;
  for (const [n, f] of Object.entries(st.eps ?? {})) {
    if (f.verified && f.from !== undefined) (out.eps ??= {})[Number(n)] = [f.from, f.to] as Range;
  }
  return out.end !== undefined || out.eps ? out : undefined;
}

/** Verified values of a season (what replaces the estimate), undefined when there are none. */
export const overrideOf = (seasonId: string) => toOverride(states[seasonId]);

export const seasonState = (seasonId: string): SeasonState | undefined => states[seasonId];

/** Restore the persisted states (once, before the catalog is shown). */
export function hydrateMapping() {
  hydrated ??= AsyncStorage.getItem(KEY)
    .then((raw) => {
      if (!raw) return;
      states = { ...JSON.parse(raw), ...states };
      version++;
      listeners.forEach((l) => l());
      refreshCatalog();
    })
    .catch(() => {});
  return hydrated;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => AsyncStorage.setItem(KEY, JSON.stringify(states)).catch(() => {}), 500);
}

/** Replace the state of some seasons (undefined: nothing left). Refreshes the catalog when needed. */
export function setSeasonStates(updates: Record<string, SeasonState | undefined>) {
  let changed = false;
  let overrides = false;
  const next = { ...states };
  for (const [id, st] of Object.entries(updates)) {
    if (JSON.stringify(next[id] ?? null) === JSON.stringify(st ?? null)) continue;
    if (overrideJson(next[id]) !== overrideJson(st)) overrides = true;
    if (st) next[id] = st;
    else delete next[id];
    changed = true;
  }
  if (!changed) return;
  states = next;
  version++;
  listeners.forEach((l) => l());
  save();
  if (overrides) refreshCatalog();
}

export function useSeasonState(seasonId: string | undefined): SeasonState | undefined {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => version,
  );
  return seasonId ? states[seasonId] : undefined;
}

/** Test helper: forget everything (no persistence involved). */
export function _resetMapping() {
  states = {};
  version++;
}
