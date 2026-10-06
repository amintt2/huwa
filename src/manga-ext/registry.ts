// Repositories the user added and sources he installed. Huwa ships none: this starts empty.
// Bundles are stored as files (<documents>/paperback/<sourceKey>.js); metadata in AsyncStorage.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { killFrame, setCodeLoader } from './bridge';
import { parseHttpUrl } from './net';
import {
  bundleUrl,
  compareVersions,
  iconUrl,
  normalizeRepoUrl,
  parseRepoLink,
  parseVersioning,
  SOURCE_ID,
  sourceKey,
  versioningUrl,
  type ContentRating,
  type RepoIndex,
  type RepoSource,
} from './repo';
import type { PaperbackFormat } from './runtime/protocol';
import { clearSourceState } from './state';
import { registerRehydrate } from '@/settings/rehydrate';

export type RepoEntry = RepoIndex & { fetchedAt: number };

export type InstalledSource = {
  key: string;
  repo: string;
  id: string;
  name: string;
  version: string;
  format: PaperbackFormat;
  icon?: string;
  language?: string;
  contentRating: ContentRating;
  installedAt: number;
  enabled: boolean;
  /** Site of the source when the repository says (0.8 `websiteBaseURL`): page of the Cloudflare check. */
  website?: string;
};

type State = { repos: RepoEntry[]; installed: InstalledSource[]; legalAccepted: boolean; showAdult: boolean };

const KEY = 'huwa/pb/registry/v1';
const MAX_VERSIONING_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 6 * 1024 * 1024;
export const extensionsSupported = Platform.OS !== 'web';

let state: State = { repos: [], installed: [], legalAccepted: false, showAdult: false };
let hydrated = false;
const listeners = new Set<() => void>();
const removeListeners = new Set<(key: string) => void>();

function commit(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
  AsyncStorage.setItem(KEY, JSON.stringify(state)).catch(() => {});
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useMangaExt = () => useSyncExternalStore(subscribe, () => state, () => state);
export const getMangaExt = () => state;
export const installedSources = () => state.installed.filter((s) => s.enabled);
export const getInstalled = (key: string) => state.installed.find((s) => s.key === key);
export const onSourceRemoved = (l: (key: string) => void) => {
  removeListeners.add(l);
  return () => removeListeners.delete(l);
};

let hydration: Promise<void> | undefined;
export function hydrateMangaExt() {
  hydration ??= (async () => {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (raw) state = { ...state, ...(JSON.parse(raw) as Partial<State>) };
    } catch {
      // keep defaults
    }
    hydrated = true;
    listeners.forEach((l) => l());
  })();
  return hydration;
}
export const isMangaExtHydrated = () => hydrated;

registerRehydrate(() => {
  if (!hydration) return;
  hydration = undefined;
  state = { repos: [], installed: [], legalAccepted: false, showAdult: false };
  return hydrateMangaExt();
});

export const setLegalAccepted = () => commit({ legalAccepted: true });
export const setShowAdult = (showAdult: boolean) => commit({ showAdult });

// ---------- files ----------

const dir = () => new Directory(Paths.document, 'paperback');
const bundleFile = (key: string) => new File(dir(), `${key}.js`);
/** The source's code is on this device (bundles are not part of a data export). */
export const hasSourceBundle = (key: string) => extensionsSupported && bundleFile(key).exists;

setCodeLoader(async (key) => {
  const s = getInstalled(key);
  if (!s) throw new Error('Source non installée');
  const f = bundleFile(key);
  if (!f.exists) throw new Error('Fichier de la source manquant, réinstalle-la');
  return { id: s.id, format: s.format, code: await f.text() };
});

// ---------- network ----------

async function fetchText(url: string, max: number, timeout = 20_000): Promise<string> {
  if (!parseHttpUrl(url)) throw new Error('URL invalide');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', headers: { Accept: 'application/json, text/javascript, */*' } });
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    const text = await res.text();
    if (text.length > max) throw new Error('Fichier trop volumineux');
    return text;
  } catch (e) {
    throw new Error(ctrl.signal.aborted ? 'Délai dépassé' : e instanceof Error ? e.message : 'Réseau indisponible');
  } finally {
    clearTimeout(timer);
  }
}

// ---------- repositories ----------

export async function fetchRepo(input: string): Promise<RepoEntry> {
  const url = normalizeRepoUrl(input);
  const text = await fetchText(versioningUrl(url), MAX_VERSIONING_BYTES);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Ce n’est pas un dépôt Paperback (versioning.json illisible)');
  }
  return { ...parseVersioning(json, url), fetchedAt: Date.now() };
}

/** Adds (or refreshes) a repository from a URL or a `paperback://` / `huwa://` link. */
export async function addRepo(input: string): Promise<{ repo: RepoEntry; install: string[] }> {
  const link = parseRepoLink(input);
  const repo = await fetchRepo(input);
  const repos = state.repos.filter((r) => r.url !== repo.url);
  commit({ repos: [...repos, repo] });
  const install = (link?.install ?? []).filter((x) => normalizeRepoUrl(x.repo) === repo.url && repo.sources.some((s) => s.id === x.id)).map((x) => x.id);
  return { repo, install };
}

export async function refreshRepo(url: string) {
  const repo = await fetchRepo(url);
  commit({ repos: state.repos.map((r) => (r.url === url ? repo : r)) });
  return repo;
}

export async function refreshAllRepos() {
  await Promise.allSettled(state.repos.map((r) => refreshRepo(r.url)));
}

export async function removeRepo(url: string) {
  for (const s of state.installed.filter((x) => x.repo === url)) await uninstallSource(s.key);
  commit({ repos: state.repos.filter((r) => r.url !== url) });
}

// ---------- sources ----------

export function updateFor(s: InstalledSource): RepoSource | undefined {
  const repo = state.repos.find((r) => r.url === s.repo);
  const latest = repo?.sources.find((x) => x.id === s.id);
  return latest && compareVersions(latest.version, s.version) > 0 ? latest : undefined;
}

export async function installSource(repoUrl: string, id: string): Promise<InstalledSource> {
  if (!extensionsSupported) throw new Error('Extensions indisponibles sur le web');
  const repo = state.repos.find((r) => r.url === repoUrl);
  const info = repo?.sources.find((s) => s.id === id);
  if (!repo || !info || !SOURCE_ID.test(id)) throw new Error('Source introuvable dans ce dépôt');
  const code = await fetchText(bundleUrl(repo.url, repo.format, id), MAX_BUNDLE_BYTES, 45_000);
  // Cheap sanity check before storing: a Paperback bundle defines the source's entry point.
  if (!(repo.format === '0.9' ? /\bsource\s*=/.test(code) : /Sources/.test(code)) || !code.includes('getMangaDetails')) {
    throw new Error('Ce fichier n’est pas une extension Paperback valide');
  }
  const key = sourceKey(repo.url, id);
  const d = dir();
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  bundleFile(key).write(code);
  killFrame(key); // reload with the new code on next use
  const entry: InstalledSource = {
    key,
    repo: repo.url,
    id,
    name: info.name,
    version: info.version,
    format: repo.format,
    icon: iconUrl(repo.url, repo.format, id, info.icon),
    language: info.language,
    contentRating: info.contentRating,
    installedAt: getInstalled(key)?.installedAt ?? Date.now(),
    enabled: true,
    website: info.website,
  };
  commit({ installed: [...state.installed.filter((s) => s.key !== key), entry] });
  return entry;
}

export async function uninstallSource(key: string) {
  killFrame(key);
  try {
    const f = bundleFile(key);
    if (f.exists) f.delete();
  } catch {
    // already gone
  }
  await clearSourceState(key);
  commit({ installed: state.installed.filter((s) => s.key !== key) });
  removeListeners.forEach((l) => l(key));
}

export const toggleSource = (key: string) =>
  commit({ installed: state.installed.map((s) => (s.key === key ? { ...s, enabled: !s.enabled } : s)) });
