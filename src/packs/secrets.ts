// Detects extension URLs that probably carry the user's own configuration or a personal key
// (debrid API key, token, encrypted config…), so they are not shared by mistake in a pack.
// Heuristic and deliberately cautious: a false positive only unchecks the row. Pure module.

export type SecretReason = 'credentials' | 'key-param' | 'debrid-key' | 'token-segment' | 'jwt' | 'uuid' | 'encoded-config' | 'opaque';

const DEBRID = /(real-?debrid|all-?debrid|premiumize|debrid-?link|torbox|offcloud|put-?io|easy-?debrid|pikpak|stremthru)/i;
const KEY_NAME = /(?:^|[^a-z])(api[-_]?key|apikey|access[-_]?token|token|secret|password|passwd|passkey|auth|session|sid|key|pin|cookie|credentials?)$/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Long run of base64/hex-looking characters mixing letters and digits (not a readable word or slug). */
function looksOpaque(seg: string) {
  if (seg.length < 24) return false;
  if (!/^[A-Za-z0-9_\-+=.~%]+$/.test(seg)) return false;
  const digits = (seg.match(/[0-9]/g) ?? []).length;
  const upper = (seg.match(/[A-Z]/g) ?? []).length;
  const lower = (seg.match(/[a-z]/g) ?? []).length;
  if (/^[0-9a-f]{32,}$/i.test(seg)) return true; // hex key / hash
  if (/^[a-z]+(-[a-z0-9]+)*$/.test(seg) && digits < 4) return false; // readable slug
  return digits >= 3 && (upper >= 3 || seg.length >= 32) && lower >= 3;
}

/** `k=v` / `k:v` pairs found in a path segment or query (Torrentio-style `a=b|c=d`). */
function pairs(s: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of s.split(/[|&;,]/)) {
    const m = /^([A-Za-z0-9_.-]{1,40})[=:](.+)$/.exec(part.trim());
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

/**
 * Reasons why this URL looks personal (empty = looks shareable). Checks credentials in the URL,
 * key/token parameters, debrid provider names followed by a key, `/token/<x>` style segments,
 * JWTs, UUIDs, base64-encoded JSON configs and long opaque segments.
 */
export function personalReasons(url: string): SecretReason[] {
  const reasons = new Set<SecretReason>();
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/i.exec(url.trim());
  if (!m) return [];
  const [, authority, rawPath, query = ''] = m;
  if (authority.includes('@')) reasons.add('credentials');

  const segments = rawPath.split('/').filter(Boolean).map(safeDecode);
  const all = [...segments, ...query.split('&').map(safeDecode)];
  const flat = all.join('/');

  for (const chunk of all) {
    for (const [k, v] of pairs(chunk)) {
      if (DEBRID.test(k) && v.length >= 6) reasons.add('debrid-key');
      else if (KEY_NAME.test(k) && v.length >= 4) reasons.add('key-param');
    }
  }
  if (new RegExp(`${DEBRID.source}[=:|/-]+[A-Za-z0-9_-]{10,}`, 'i').test(flat)) reasons.add('debrid-key');

  for (let i = 0; i < segments.length - 1; i++) {
    if (KEY_NAME.test(segments[i]) && segments[i + 1].length >= 8 && !/^manifest\.json$/i.test(segments[i + 1])) reasons.add('token-segment');
  }
  if (JWT.test(flat)) reasons.add('jwt');
  if (UUID.test(flat)) reasons.add('uuid');

  for (const seg of segments) {
    if (/^manifest\.json$/i.test(seg) || /^versioning\.json$/i.test(seg)) continue;
    // Base64 of a JSON object (`{"` → `eyJ`) or raw JSON: addon configs often hold keys.
    if (/^eyJ[A-Za-z0-9_\-+/=]{12,}/.test(seg) || /^\{.*:.*\}$/.test(seg)) reasons.add('encoded-config');
    else if (seg.split(/[|&;,]/).some((part) => looksOpaque(part.replace(/^[^=:]{1,40}[=:]/, '')))) reasons.add('opaque');
  }
  return [...reasons];
}

export const looksPersonal = (url: string) => personalReasons(url).length > 0;

export const PERSONAL_WARNING =
  'Ce lien contient peut-être ta configuration ou une clé personnelle (débrid…). Ne le partage qu’avec des personnes de confiance.';
