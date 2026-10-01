// Validation of the installed add-ons read from storage (which a data import can fill).
import { validManifest, type Manifest } from './protocol';

type Saved = { baseUrl: string; manifest: Manifest; enabled: boolean };

/**
 * Keeps only well-formed entries: an http(s) base URL (or the built-in one, whose manifest is always
 * rebuilt from `builtin`), a valid manifest, once each. `enabled` defaults to true.
 */
export function parseSavedAddons<T extends Saved>(v: unknown, builtin: T): (T | Saved)[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: (T | Saved)[] = [];
  for (const a of v) {
    if (!a || typeof a !== 'object') continue;
    const { baseUrl, enabled, manifest } = a as Partial<Saved>;
    if (typeof baseUrl !== 'string' || baseUrl.length > 2048 || seen.has(baseUrl)) continue;
    if (baseUrl === builtin.baseUrl) {
      seen.add(baseUrl);
      out.push({ ...builtin, enabled: enabled !== false });
      continue;
    }
    if (!/^https?:\/\/\S+$/i.test(baseUrl) || !validManifest(manifest)) continue;
    seen.add(baseUrl);
    out.push({ baseUrl, enabled: enabled !== false, manifest });
  }
  return out;
}
