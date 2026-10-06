// Installed addons (persisted, in priority order) and the addon preferences: the store behind
// `useAddons` (./registry.ts). No React here, so it is unit-tested directly.
// - Changes made before the saved list is loaded (cold start from an install link) wait for it.
// - Writes are chained: the last write always holds the latest list, and `installAddon` resolves
//   only once the new list is on disk (the add sheet shows "Ajout…" until then).
// - `setHash` identifies the installed set (order, enabled, manifests): the stream / subtitle
//   aggregates are keyed by it, so a change never serves an aggregate built for the old set.
// - `onAddonsAdded`: an addon became usable (installed, re-installed with another URL, enabled),
//   e.g. to search its sources at once for the series page that is open (presearch).
import AsyncStorage from '@react-native-async-storage/async-storage';

import { registerRehydrate } from '@/settings/rehydrate';

import { fetchManifest, normalizeAddonUrl, validManifest, type Manifest } from './protocol';
import type { Quality } from './quality';
import { parseSavedAddons } from './saved';

export type InstalledAddon = { baseUrl: string; manifest: Manifest; enabled: boolean };
export type AddonPrefs = { preferredQuality: Quality | 'auto'; legalAccepted: boolean };

export const ADDONS_KEY = 'huwa/addons/v1';
const PREFS_KEY = 'huwa/addon-prefs/v1';
export const BUILTIN_ID = 'huwa.demo';

export const builtin: InstalledAddon = {
  baseUrl: 'builtin:demo',
  enabled: true,
  manifest: {
    id: BUILTIN_ID,
    name: 'Démo Huwa',
    description: 'Flux de démonstration libres de droits. Installe un addon pour de vrais contenus.',
    resources: ['stream'],
    types: ['series', 'movie', 'anime'],
  },
};

const DEFAULT_PREFS: AddonPrefs = { preferredQuality: 1080, legalAccepted: false };

/** Short hash (FNV-1a, 2 × 32 bits) of the installed set: order, enabled state and manifests. */
export function addonSetHash(addons: readonly InstalledAddon[]): string {
  const text = JSON.stringify(addons.map((a) => [a.baseUrl, a.enabled, a.manifest]));
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

type State = { addons: InstalledAddon[]; prefs: AddonPrefs; setHash: string };
const initial = (): State => ({ addons: [builtin], prefs: DEFAULT_PREFS, setHash: addonSetHash([builtin]) });

let state: State = initial();
let hydrating: Promise<void> | undefined;
/** The saved list is loaded: writing it now cannot overwrite what the user installed before. */
let hydrated = false;
let earlyPrefs: Partial<AddonPrefs> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

type AddedListener = (added: InstalledAddon[]) => void;
const addedListeners = new Set<AddedListener>();

export const getAddonsState = () => state;
export const isAddonsHydrated = () => hydrated;

export function subscribeAddons(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Called after a change that made addons usable (new, new URL, enabled). */
export function onAddonsAdded(l: AddedListener) {
  addedListeners.add(l);
  return () => {
    addedListeners.delete(l);
  };
}

/** Enabled addons of `next` that were not usable in `prev` (same URL, enabled). */
export function newlyUsable(prev: readonly InstalledAddon[], next: readonly InstalledAddon[]): InstalledAddon[] {
  const before = new Set(prev.filter((a) => a.enabled).map((a) => a.baseUrl));
  return next.filter((a) => a.enabled && !before.has(a.baseUrl));
}

let persisting: Promise<void> = Promise.resolve();
/** Queues a write of the current list (chained: never an older list written after a newer one). */
function persistAddons(): Promise<void> {
  persisting = persisting
    .then(() => AsyncStorage.setItem(ADDONS_KEY, JSON.stringify(state.addons)))
    .catch(() => {});
  return persisting;
}

/**
 * Applies a change to the installed list; resolves once it is written. Before the saved list is
 * loaded (e.g. a `/install` deep link on a cold start), the change waits for it: applied to the
 * saved list, not to the defaults, so it never overwrites the user's addons.
 */
export function commitAddons(update: (addons: InstalledAddon[]) => InstalledAddon[]): Promise<void> {
  if (!hydrated) return hydrateAddons().then(() => commitAddons(update));
  const prev = state.addons;
  const next = update(prev);
  if (next === prev) return persisting;
  state = { ...state, addons: next, setHash: addonSetHash(next) };
  emit();
  const added = newlyUsable(prev, next);
  if (added.length) addedListeners.forEach((l) => l(added));
  // The demo entry is stored only as a placeholder (position + enabled); its manifest is rebuilt at load.
  return persistAddons();
}

export function setPrefs(p: Partial<AddonPrefs>) {
  state = { ...state, prefs: { ...state.prefs, ...p } };
  emit();
  // Too early: kept and applied over the saved prefs once they are loaded.
  if (!hydrated) earlyPrefs = { ...earlyPrefs, ...p };
  else AsyncStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)).catch(() => {});
}

// Backup import: reload from storage. Not loaded yet → the first load will read the imported
// values. Otherwise the in-memory list is reset and re-read (changes made meanwhile wait for it,
// see `commitAddons`).
registerRehydrate(async () => {
  if (!hydrating) return;
  await hydrating;
  hydrated = false;
  hydrating = undefined;
  state = initial();
  return hydrateAddons();
});

export function hydrateAddons(): Promise<void> {
  hydrating ??= loadAddons().finally(() => {
    hydrated = true;
    if (earlyPrefs) {
      state = { ...state, prefs: { ...state.prefs, ...earlyPrefs } };
      earlyPrefs = null;
      AsyncStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)).catch(() => {});
    }
    // Screens waiting for the saved list (see `useAddonsHydrated`) start now.
    emit();
  });
  return hydrating;
}

async function loadAddons() {
  try {
    const [raw, rawPrefs] = await Promise.all([AsyncStorage.getItem(ADDONS_KEY), AsyncStorage.getItem(PREFS_KEY)]);
    let addons = state.addons;
    if (raw) {
      const saved = parseSavedAddons(JSON.parse(raw), builtin);
      addons = saved.map((a) => (a.baseUrl === builtin.baseUrl ? { ...builtin, enabled: a.enabled } : a));
      if (!addons.some((a) => a.baseUrl === builtin.baseUrl)) addons = [builtin, ...addons];
    }
    const prefs = rawPrefs ? { ...state.prefs, ...(JSON.parse(rawPrefs) as Partial<AddonPrefs>) } : state.prefs;
    state = { addons, prefs, setHash: addonSetHash(addons) };
  } catch {
    // keep defaults
  }
}

/** Fetches and validates an addon without installing it (for the confirmation sheet). */
export async function previewAddon(input: string) {
  const baseUrl = normalizeAddonUrl(input);
  const [manifest] = await Promise.all([fetchManifest(baseUrl), hydrateAddons()]);
  // Compared with the saved list (not the defaults of a cold start).
  const existing = state.addons.find((a) => a.manifest.id === manifest.id);
  return { baseUrl, manifest, existing };
}

/**
 * Installs an addon: its manifest is fetched (or the previewed one validated) before anything is
 * stored, so stream requests never wait for it. Resolves once the new list is saved. An addon
 * with the same id is replaced in place (same priority): that is how a reconfigured addon (new
 * URL carrying its settings) updates, as in Stremio.
 */
export async function installAddon(input: string, preloaded?: Manifest) {
  const baseUrl = normalizeAddonUrl(input);
  const manifest = preloaded ?? (await fetchManifest(baseUrl));
  if (!validManifest(manifest)) throw new Error('Ce lien n’est pas un manifest d’addon Stremio');
  await hydrateAddons();
  await commitAddons((addons) => {
    const i = addons.findIndex((a) => a.manifest.id === manifest.id);
    if (i < 0) return [...addons, { baseUrl, manifest, enabled: true }];
    const next = [...addons];
    next[i] = { ...next[i], baseUrl, manifest };
    return next;
  });
  return manifest;
}

/** Re-reads the manifest of an installed addon (new catalogs, version…). */
export async function refreshAddon(baseUrl: string) {
  const manifest = await fetchManifest(baseUrl);
  await commitAddons((addons) => addons.map((a) => (a.baseUrl === baseUrl ? { ...a, manifest } : a)));
  return manifest;
}

export const removeAddon = (baseUrl: string) =>
  commitAddons((addons) => addons.filter((a) => a.baseUrl !== baseUrl || a.baseUrl === builtin.baseUrl));
export const toggleAddon = (baseUrl: string) =>
  commitAddons((addons) => addons.map((a) => (a.baseUrl === baseUrl ? { ...a, enabled: !a.enabled } : a)));

/** Moves an addon up (-1) or down (+1) in the priority list. */
export function moveAddon(baseUrl: string, dir: -1 | 1) {
  return commitAddons((addons) => {
    const list = [...addons];
    const i = list.findIndex((a) => a.baseUrl === baseUrl);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return addons;
    [list[i], list[j]] = [list[j], list[i]];
    return list;
  });
}

export const getAddonByBase = (baseUrl: string) => state.addons.find((a) => a.baseUrl === baseUrl);

/** Test helper: back to a cold start (nothing loaded). */
export function resetAddonStoreForTests() {
  state = initial();
  hydrating = undefined;
  hydrated = false;
  earlyPrefs = null;
  persisting = Promise.resolve();
}
