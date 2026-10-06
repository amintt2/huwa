// Loading and installing a pack, one extension at a time, through the regular install paths
// (Stremio manifest fetch + validation, Paperback repository + source install).
import { needsConfiguration, normalizeAddonUrl } from '@/addons/protocol';
import { getAddonByBase, hydrateAddons, installAddon, previewAddon, setPrefs, type InstalledAddon } from '@/addons/registry';
import { isBlockedHost, parseHttpUrl } from '@/manga-ext/net';
import {
  addRepo,
  extensionsSupported,
  getMangaExt,
  hydrateMangaExt,
  installSource,
  setLegalAccepted,
  type InstalledSource,
  type RepoEntry,
} from '@/manga-ext/registry';
import { normalizeRepoUrl } from '@/manga-ext/repo';

import { decodePack, MAX_JSON_BYTES, PackError, parsePackJson, type Pack, type PackManga, type PackRef, type PackVideo } from './format';

export const PACK_NOTICE =
  'Huwa ne fournit ni ne vérifie ces extensions : elles viennent de la personne qui a partagé ce pack. Tu es responsable de ce que tu installes.';

/** Pack JSON hosted somewhere (`huwa://pack?url=…`): http(s) only, 64 KB, 15 s. */
export async function fetchPack(url: string): Promise<Pack> {
  const p = parseHttpUrl(url);
  if (!p || isBlockedHost(p.host)) throw new PackError('Adresse du pack invalide');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new PackError(`Pack injoignable (erreur ${res.status})`);
    if (Number(res.headers.get('content-length') ?? 0) > MAX_JSON_BYTES) throw new PackError('Pack trop volumineux');
    return parsePackJson(await res.text());
  } catch (e) {
    if (e instanceof PackError) throw e;
    throw new PackError(ctrl.signal.aborted ? 'Pack injoignable (délai dépassé)' : 'Pack injoignable');
  } finally {
    clearTimeout(timer);
  }
}

export const loadPack = (ref: PackRef): Promise<Pack> => ('d' in ref ? Promise.resolve().then(() => decodePack(ref.d)) : fetchPack(ref.url));

export const hostOf = (u: string) => /^https?:\/\/([^/?#]+)/i.exec(u)?.[1] ?? u;

// ---------- state of each entry ----------

export function videoInstalled(e: PackVideo, addons: InstalledAddon[]) {
  try {
    const base = normalizeAddonUrl(e.manifest);
    return addons.some((a) => a.baseUrl === base);
  } catch {
    return false;
  }
}

export function mangaInstalled(e: PackManga, repos: RepoEntry[], installed: InstalledSource[]) {
  try {
    const url = normalizeRepoUrl(e.repo);
    return repos.some((r) => r.url === url) && (e.sources ?? []).every((id) => installed.some((s) => s.repo === url && s.id === id));
  } catch {
    return false;
  }
}

// ---------- install ----------

export type RowResult = { state: 'done' | 'already' | 'failed'; message?: string };

/** Short, readable failure reason (native fetch errors carry stack locations and class names). */
const reason = (e: unknown) => {
  const msg = e instanceof Error && e.message ? e.message : 'Erreur inconnue';
  return msg.replace(/\s*\(at [^)]*\)/g, '').replace(/fetch failed:\s*/i, '').replace(/\b\w*Exception:\s*/g, '').replace(/\(\s*\)/g, '').trim().slice(0, 160);
};

export async function installVideo(e: PackVideo): Promise<RowResult> {
  try {
    const base = normalizeAddonUrl(e.manifest);
    // Compared with the saved list, not the defaults of a cold start (pack link opening the app).
    await hydrateAddons();
    if (getAddonByBase(base)) return { state: 'already' };
    const { manifest, existing } = await previewAddon(base);
    // Same addon already installed with another URL: keep the user's own configuration.
    if (existing) return { state: 'already', message: 'Déjà installée avec une autre configuration (conservée)' };
    if (needsConfiguration(manifest)) return { state: 'failed', message: 'Doit d’abord être configurée sur son site' };
    setPrefs({ legalAccepted: true });
    await installAddon(base, manifest);
    return { state: 'done', message: manifest.name };
  } catch (err) {
    return { state: 'failed', message: reason(err) };
  }
}

export async function installManga(e: PackManga): Promise<RowResult> {
  if (!extensionsSupported) return { state: 'failed', message: 'Extensions manhwa indisponibles sur le web' };
  try {
    await hydrateMangaExt();
    const url = normalizeRepoUrl(e.repo);
    const want = e.sources ?? [];
    const isInstalled = (id: string) => getMangaExt().installed.some((s) => s.repo === url && s.id === id);
    const hadRepo = getMangaExt().repos.some((r) => r.url === url);
    const missing = want.filter((id) => !isInstalled(id));
    if (hadRepo && !missing.length) return { state: 'already' };
    setLegalAccepted();
    if (!hadRepo) await addRepo(url);
    const repo = getMangaExt().repos.find((r) => r.url === url);
    if (!repo) return { state: 'failed', message: 'Dépôt introuvable' };
    const failures: string[] = [];
    let ok = 0;
    for (const id of missing) {
      const info = repo.sources.find((s) => s.id === id);
      if (!info) {
        failures.push(`${id} : absente du dépôt`);
        continue;
      }
      try {
        await installSource(url, id);
        ok++;
      } catch (err) {
        failures.push(`${info.name} : ${reason(err)}`);
      }
    }
    const parts = [!hadRepo && 'Dépôt ajouté', ok > 0 && `${ok} source${ok > 1 ? 's' : ''} installée${ok > 1 ? 's' : ''}`, ...failures].filter(Boolean);
    // Nothing of what was asked got installed (the repository itself may have been added).
    return { state: missing.length && !ok ? 'failed' : 'done', message: parts.join(' · ') };
  } catch (err) {
    return { state: 'failed', message: reason(err) };
  }
}
