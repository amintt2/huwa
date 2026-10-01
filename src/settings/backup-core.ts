// Pure rules of the data export / import (src/settings/backup.ts), unit tested.
// What goes in a backup: every `huwa/*` AsyncStorage key, minus re-fetchable caches, cookies and
// per-source state, device-bound identity material and indexes of files that are not exported.

export const PREFIX = 'huwa/';

/** Keys never exported nor restored (and left untouched on this device by an import). */
const EXCLUDED_KEYS = new Set([
  'huwa/catalog/v2', // catalog cache
  'huwa/ids/v2', // id mapping cache
  'huwa/franchise/v1', // AniList relations cache
  'huwa/episode-offsets/v1', // downloaded offsets index
  'huwa/downloads/v1', // index of chapter files on this device (files are not exported)
  'huwa/p2p/local/v1', // single-device P2P backend: bound to the keys of this device's Keychain
  'huwa/p2p/bare/migrated',
  'huwa/cloud-backup/v1', // iCloud Keychain switch, follows the Keychain item of this device
]);
const EXCLUDED_PREFIXES = [
  'huwa/streams/', // resolved stream links (may hold debrid download URLs)
  'huwa/pb/state/', // extension cookies / session state
  'huwa/secure/', // web fallback of the secure store
  'huwa/passkey/', // passkey record of this device's account
];

export const isExportable = (key: string) =>
  key.startsWith(PREFIX) && !EXCLUDED_KEYS.has(key) && !EXCLUDED_PREFIXES.some((p) => key.startsWith(p));

export const ADDONS_KEY = 'huwa/addons/v1';
export const MANGA_EXT_KEY = 'huwa/pb/registry/v1';

/**
 * Add-on URLs often carry the user's configuration in their path or query (debrid API keys,
 * tokens, encrypted configs): `https://host/realdebrid=KEY|…/`. Heuristic, on purpose generous.
 */
export function addonUrlHasPersonalConfig(baseUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return true;
  }
  if (u.username || u.password || u.search) return true;
  return u.pathname
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .some((seg) => /[=|{}:,]/.test(seg) || (seg.length >= 24 && /^[A-Za-z0-9_\-+.~%]+$/.test(seg)));
}

type AddonLike = { baseUrl?: unknown };

/** Number of installed add-ons whose URL looks personal, in a backup's data. */
export function personalAddonCount(data: Record<string, string>): number {
  const list = parseArray(data[ADDONS_KEY]);
  return list.filter((a) => typeof (a as AddonLike).baseUrl === 'string' && addonUrlHasPersonalConfig((a as AddonLike).baseUrl as string)).length;
}

/** Copy of `data` without the add-ons whose URL looks personal. */
export function withoutPersonalAddons(data: Record<string, string>): Record<string, string> {
  const raw = data[ADDONS_KEY];
  if (raw == null) return data;
  const list = parseArray(raw).filter((a) => typeof (a as AddonLike).baseUrl === 'string' && !addonUrlHasPersonalConfig((a as AddonLike).baseUrl as string));
  return { ...data, [ADDONS_KEY]: JSON.stringify(list) };
}

function parseArray(raw: string | undefined): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Exportable pairs of an AsyncStorage dump. */
export function exportData(pairs: readonly (readonly [string, string | null])[]): Record<string, string> {
  const data: Record<string, string> = {};
  for (const [k, v] of pairs) if (v != null && isExportable(k)) data[k] = v;
  return data;
}

/**
 * Import plan: write the exportable keys of the backup first, then remove the exportable keys of
 * this device that the backup does not have (a failure half-way never leaves an empty device).
 * Excluded keys in an (older) backup are ignored; this device's caches stay.
 */
export function planRestore(existingKeys: readonly string[], backup: Record<string, string>) {
  const set = Object.entries(backup).filter(([k, v]) => isExportable(k) && typeof v === 'string') as [string, string][];
  const keep = new Set(set.map(([k]) => k));
  const remove = existingKeys.filter((k) => isExportable(k) && !keep.has(k));
  return { set, remove };
}

/**
 * Paperback source bundles are files, not in the backup: drop the installed entries whose bundle is
 * missing on this device (they would fail with "Fichier de la source manquant"). Their repositories
 * stay, so they can be reinstalled in one tap.
 */
export function dropMissingSources(raw: string, hasBundle: (key: string) => boolean): { raw: string; dropped: string[] } {
  try {
    const state = JSON.parse(raw) as { installed?: { key?: unknown; name?: unknown }[] };
    if (!state || !Array.isArray(state.installed)) return { raw, dropped: [] };
    const dropped: string[] = [];
    const installed = state.installed.filter((s) => {
      const ok = typeof s?.key === 'string' && hasBundle(s.key);
      if (!ok) dropped.push(typeof s?.name === 'string' ? s.name : String(s?.key ?? '?'));
      return ok;
    });
    return { raw: JSON.stringify({ ...state, installed }), dropped };
  } catch {
    return { raw, dropped: [] };
  }
}
