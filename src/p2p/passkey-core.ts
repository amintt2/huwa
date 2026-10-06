// Passkey that carries the account (pure logic, no React Native: tested under node).
//
// Huwa has no server, so a passkey cannot "log in" to anything. Instead it guards a largeBlob
// (WebAuthn extension, stored and synced by the password manager, released only after the
// user's Face ID / device unlock) holding the recovery phrase:
//   - PRF available (iOS 18+, provider support): AES-256-GCM with a key derived from the PRF
//     output, so the blob is useless without the passkey itself → `enc: "prf-aes256gcm"`;
//   - otherwise the phrase as-is (`enc: "none"`): the blob is already end-to-end encrypted by
//     the provider and only released after the user verification of that same passkey.
// The challenge is random and never checked (nothing to check it against): the security comes
// from the provider gating the blob, not from a signature verification.
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { isValidPhrase } from '@/social/identity';

export const RP_ID = 'huwa.mciut.fr';
const LABEL = 'huwa-passkey-v1';
const KEY_INFO = utf8ToBytes('huwa/passkey/phrase-key/v1');
const AAD = utf8ToBytes(LABEL);
export const MAX_BLOB = 1024;

/** Fixed PRF salt: sha256("huwa-passkey-v1"). Same salt on every device → same key. */
export const prfSalt = () => sha256(utf8ToBytes(LABEL));

/** Stable WebAuthn user handle for an identity: re-creating replaces the passkey in iCloud Keychain. */
export const userIdFor = (identityKey: string) => sha256(utf8ToBytes(`huwa/passkey/user/v1:${identityKey}`)).slice(0, 16);

/** 32-byte AES key from the PRF output. */
export function deriveKey(prfOutput: Uint8Array): Uint8Array {
  if (prfOutput.length < 32) throw new PasskeyError('failed', 'Sortie PRF trop courte');
  return hkdf(sha256, prfOutput, utf8ToBytes(LABEL), KEY_INFO, 32);
}

// ---------- base64 (standard alphabet, padding) ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[\s=]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (/[^A-Za-z0-9+/]/.test(clean) || clean.length % 4 === 1) throw new PasskeyError('bad-blob', 'Base64 invalide');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let j = 0;
  for (const ch of clean) {
    value = (value << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (value >> bits) & 0xff;
    }
  }
  return out.slice(0, j);
}

// ---------- errors ----------

export type PasskeyErrorCode =
  | 'cancelled'
  | 'no-credentials'
  | 'unsupported'
  | 'not-associated'
  | 'exists'
  | 'busy'
  | 'failed'
  | 'no-large-blob'
  | 'write-failed'
  | 'no-blob'
  | 'bad-blob'
  | 'prf-unavailable'
  | 'decrypt-failed';

export class PasskeyError extends Error {
  code: PasskeyErrorCode;
  /** Credential created before the failure (setup interrupted after registration). */
  credentialId?: string;
  /** What happened, step by step (e.g. `combined:blob=0,prf=1 → blob-only:blob=1`), for support. */
  trace?: string;
  constructor(code: PasskeyErrorCode, message: string, credentialId?: string) {
    super(message);
    this.name = 'PasskeyError';
    this.code = code;
    this.credentialId = credentialId;
  }
}

const NATIVE_CODES = new Set<PasskeyErrorCode>(['cancelled', 'no-credentials', 'unsupported', 'not-associated', 'exists', 'busy', 'failed']);

/** Native rejection (`{ code, message }`) or anything else → PasskeyError. */
export function asPasskeyError(e: unknown, credentialId?: string): PasskeyError {
  if (e instanceof PasskeyError) return e;
  const code = (e as { code?: unknown })?.code;
  const message = e instanceof Error ? e.message : String(e);
  return new PasskeyError(typeof code === 'string' && NATIVE_CODES.has(code as PasskeyErrorCode) ? (code as PasskeyErrorCode) : 'failed', message, credentialId);
}

// ---------- payload ----------

export type PasskeyPayload =
  | { v: 1; enc: 'none'; phrase: string }
  | { v: 1; enc: 'prf-aes256gcm'; n: string; c: string };

export function encodePayload(p: PasskeyPayload): Uint8Array {
  const bytes = utf8ToBytes(JSON.stringify(p));
  if (bytes.length > MAX_BLOB) throw new PasskeyError('failed', 'Contenu trop volumineux pour la clé d’accès');
  return bytes;
}

export function decodePayload(bytes: Uint8Array): PasskeyPayload {
  if (!bytes.length) throw new PasskeyError('no-blob', 'Cette clé d’accès ne contient pas de compte Huwa');
  if (bytes.length > MAX_BLOB) throw new PasskeyError('bad-blob', 'Contenu illisible');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PasskeyError('bad-blob', 'Contenu illisible');
  }
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== 'object' || o.v !== 1) throw new PasskeyError('bad-blob', 'Version inconnue : mets Huwa à jour');
  if (o.enc === 'none' && typeof o.phrase === 'string') return { v: 1, enc: 'none', phrase: o.phrase };
  if (o.enc === 'prf-aes256gcm' && typeof o.n === 'string' && typeof o.c === 'string') return { v: 1, enc: 'prf-aes256gcm', n: o.n, c: o.c };
  throw new PasskeyError('bad-blob', 'Contenu illisible');
}

/** AES-256-GCM: `seal` returns ciphertext‖tag(16). expo-crypto in the app, node:crypto in tests. */
export type Aead = {
  seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
};

export async function sealPhrase(
  words: string[],
  opts: { prf?: Uint8Array; aead: Aead; random: (n: number) => Uint8Array },
): Promise<PasskeyPayload> {
  if (!isValidPhrase(words)) throw new PasskeyError('failed', 'Phrase de récupération invalide');
  const phrase = words.join(' ');
  if (!opts.prf) return { v: 1, enc: 'none', phrase };
  const nonce = opts.random(12);
  const sealed = await opts.aead.seal(deriveKey(opts.prf), nonce, utf8ToBytes(phrase), AAD);
  return { v: 1, enc: 'prf-aes256gcm', n: toBase64(nonce), c: toBase64(sealed) };
}

export async function openPhrase(p: PasskeyPayload, opts: { prf?: Uint8Array; aead: Aead }): Promise<string[]> {
  let phrase: string;
  if (p.enc === 'none') phrase = p.phrase;
  else {
    if (!opts.prf) throw new PasskeyError('prf-unavailable', 'Ce gestionnaire de mots de passe ne peut pas déverrouiller cette clé ici');
    try {
      const plain = await opts.aead.open(deriveKey(opts.prf), fromBase64(p.n), fromBase64(p.c), AAD);
      phrase = new TextDecoder().decode(plain);
    } catch (e) {
      if (e instanceof PasskeyError && e.code !== 'bad-blob') throw e;
      throw new PasskeyError('decrypt-failed', 'Déchiffrement impossible');
    }
  }
  const words = phrase.trim().split(/\s+/);
  if (!isValidPhrase(words)) throw new PasskeyError('bad-blob', 'La phrase contenue dans la clé d’accès est invalide');
  return words;
}

// ---------- which password manager? (AAGUID in the attestation's authenticator data) ----------

/** Minimal CBOR reader: enough for an attestation object (maps, strings, byte strings, ints, arrays). */
function readCbor(buf: Uint8Array, pos = 0): [unknown, number] {
  const head = buf[pos++];
  if (head === undefined) throw new Error('cbor: fin inattendue');
  const major = head >> 5;
  const info = head & 31;
  let len: number;
  if (info < 24) len = info;
  else if (info === 24) len = buf[pos++];
  else if (info === 25) {
    len = (buf[pos] << 8) | buf[pos + 1];
    pos += 2;
  } else if (info === 26) {
    len = ((buf[pos] << 24) >>> 0) + ((buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]);
    pos += 4;
  } else throw new Error('cbor: longueur non prise en charge');
  switch (major) {
    case 0:
      return [len, pos];
    case 1:
      return [-1 - len, pos];
    case 2:
      if (pos + len > buf.length) throw new Error('cbor: fin inattendue');
      return [buf.slice(pos, pos + len), pos + len];
    case 3:
      if (pos + len > buf.length) throw new Error('cbor: fin inattendue');
      return [new TextDecoder().decode(buf.slice(pos, pos + len)), pos + len];
    case 4: {
      const arr: unknown[] = [];
      for (let i = 0; i < len; i++) {
        const [v, p] = readCbor(buf, pos);
        arr.push(v);
        pos = p;
      }
      return [arr, pos];
    }
    case 5: {
      const map = new Map<unknown, unknown>();
      for (let i = 0; i < len; i++) {
        const [k, p1] = readCbor(buf, pos);
        const [v, p2] = readCbor(buf, p1);
        map.set(k, v);
        pos = p2;
      }
      return [map, pos];
    }
    case 7:
      return [info === 21 ? true : info === 20 ? false : null, pos];
    default:
      throw new Error('cbor: type non pris en charge');
  }
}

/** AAGUID (uuid string) of the authenticator, or undefined (absent or all zeros). */
export function aaguidFromAttestation(attestationObject: Uint8Array): string | undefined {
  try {
    const [map] = readCbor(attestationObject);
    const authData = map instanceof Map ? map.get('authData') : undefined;
    // rpIdHash(32) flags(1) signCount(4) then attested credential data (AT flag 0x40): aaguid(16)
    if (!(authData instanceof Uint8Array) || authData.length < 53 || !(authData[32] & 0x40)) return undefined;
    const hex = bytesToHex(authData.slice(37, 53));
    if (/^0+$/.test(hex)) return undefined;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return undefined;
  }
}

// Public AAGUIDs (passkey-authenticator-aaguids community list).
const PROVIDERS: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'Trousseau iCloud',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'Trousseau iCloud',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Gestionnaire de mots de passe Google',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  '50726f74-6f6e-5061-7373-50726f746f6e': 'Proton Pass',
  'b5397666-4885-aa6b-cebf-e52262a439a9': 'NordPass',
  'fdb141b2-5d84-443e-8a35-4698c205a502': 'KeePassXC',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
};

export const providerName = (aaguid: string | undefined) => (aaguid ? PROVIDERS[aaguid] : undefined);

// ---------- flows (native calls injected) ----------

export type PasskeyNative = {
  register(o: { userName: string; displayName: string; userId: Uint8Array; challenge: Uint8Array; prfSalt: Uint8Array }): Promise<{
    credentialId: string;
    attestationObject?: Uint8Array;
    largeBlob: boolean;
    prf: boolean;
    prfFirst?: Uint8Array;
  }>;
  writeBlob(o: { credentialId: string; challenge: Uint8Array; data: Uint8Array }): Promise<{ written: boolean }>;
  authenticate(o: { challenge: Uint8Array; credentialId?: string; readBlob: boolean; prfSalt?: Uint8Array; immediate?: boolean }): Promise<{
    credentialId: string;
    userHandle?: Uint8Array;
    blob?: Uint8Array;
    prfFirst?: Uint8Array;
  }>;
};

/** What the app keeps locally about the passkey (no secret material). */
export type PasskeyRecord = {
  credentialId: string;
  identity: string;
  createdAt: number;
  aaguid?: string;
  provider?: string;
  largeBlob: boolean;
  prf: boolean;
  enc: PasskeyPayload['enc'];
};

export type SetupStep = 'register' | 'unlock' | 'write' | 'done';

export type SetupDeps = {
  native: PasskeyNative;
  aead: Aead;
  random: (n: number) => Uint8Array;
  now: () => number;
  onStep?: (s: SetupStep) => void;
};

/**
 * Creation (Face ID #1) → if PRF was not evaluated at creation, an assertion to get it (#2) →
 * assertion writing the blob (#2 or #3). largeBlob can only be written during an assertion.
 */
export async function setupPasskey(
  user: { key: string; name: string; fingerprint: string },
  words: string[],
  deps: SetupDeps,
): Promise<PasskeyRecord> {
  if (!isValidPhrase(words)) throw new PasskeyError('failed', 'Phrase de récupération indisponible sur cet appareil');
  const salt = prfSalt();
  deps.onStep?.('register');
  let reg;
  try {
    reg = await deps.native.register({
      userName: `${user.name} · ${user.fingerprint}`,
      displayName: user.name,
      userId: userIdFor(user.key),
      challenge: deps.random(32),
      prfSalt: salt,
    });
  } catch (e) {
    throw asPasskeyError(e);
  }
  const id = reg.credentialId;
  const aaguid = reg.attestationObject ? aaguidFromAttestation(reg.attestationObject) : undefined;
  if (!reg.largeBlob) throw new PasskeyError('no-large-blob', 'Ce gestionnaire de mots de passe ne peut pas transporter ton compte', id);

  try {
    let prf = reg.prfFirst;
    if (!prf && reg.prf) {
      deps.onStep?.('unlock');
      prf = (await deps.native.authenticate({ challenge: deps.random(32), credentialId: id, readBlob: false, prfSalt: salt })).prfFirst;
    }
    const payload = await sealPhrase(words, { prf, aead: deps.aead, random: deps.random });
    deps.onStep?.('write');
    const { written } = await deps.native.writeBlob({ credentialId: id, challenge: deps.random(32), data: encodePayload(payload) });
    if (!written) throw new PasskeyError('write-failed', 'Le gestionnaire n’a pas enregistré le compte dans la clé d’accès', id);
    deps.onStep?.('done');
    return { credentialId: id, identity: user.key, createdAt: deps.now(), aaguid, provider: providerName(aaguid), largeBlob: true, prf: !!prf, enc: payload.enc };
  } catch (e) {
    throw asPasskeyError(e, id);
  }
}

/**
 * Pick the passkey, read the blob (+ PRF), return the recovery phrase. One assertion asking for
 * both; when a provider does not answer both extensions in the same assertion (blob or PRF
 * missing, assertion failing after the user verification), each one is asked again on its own
 * for the same credential. Every step is kept in `trace` on the error.
 */
export async function loginWithPasskey(
  deps: { native: PasskeyNative; aead: Aead; random: (n: number) => Uint8Array; log?: (msg: string) => void },
  opts: { immediate?: boolean } = {},
): Promise<{ words: string[]; credentialId: string; prf: boolean; enc: PasskeyPayload['enc'] }> {
  const steps: string[] = [];
  const fail = (e: unknown, credentialId?: string): PasskeyError => {
    const err = asPasskeyError(e, credentialId);
    err.trace = [...steps, `error:${err.code}`].join(' → ');
    deps.log?.(`passkey login failed: ${err.trace} (${err.message})`);
    return err;
  };
  const salt = prfSalt();
  const ask = async (label: string, o: { credentialId?: string; readBlob: boolean; prf: boolean; immediate?: boolean }) => {
    const a = await deps.native.authenticate({ challenge: deps.random(32), credentialId: o.credentialId, readBlob: o.readBlob, prfSalt: o.prf ? salt : undefined, immediate: o.immediate });
    steps.push(`${label}:blob=${a.blob?.length ? a.blob.length : 0},prf=${a.prfFirst?.length ? 1 : 0}`);
    return a;
  };

  let a;
  try {
    a = await ask('combined', { readBlob: true, prf: true, immediate: opts.immediate });
  } catch (e) {
    const err = asPasskeyError(e);
    steps.push(`combined:${err.code}`);
    // Cancelled / nothing on this device / busy: the user's answer, not a provider limitation.
    if (err.code !== 'failed') throw fail(err);
    try {
      a = await ask('blob-only', { readBlob: true, prf: false });
    } catch (e2) {
      throw fail(e2);
    }
  }
  const id = a.credentialId;
  let blob = a.blob;
  let prf = a.prfFirst;
  try {
    if (!blob?.length) blob = (await ask('blob-only', { credentialId: id, readBlob: true, prf: false })).blob;
    if (!blob?.length) throw new PasskeyError('no-blob', 'Cette clé d’accès ne contient pas de compte Huwa', id);
    const payload = decodePayload(blob);
    if (payload.enc === 'prf-aes256gcm' && !prf) prf = (await ask('prf-only', { credentialId: id, readBlob: false, prf: true })).prfFirst;
    let words: string[];
    try {
      words = await openPhrase(payload, { prf, aead: deps.aead });
    } catch (e) {
      // A PRF output returned next to the blob could differ from a PRF-only assertion: one more try.
      if (!(e instanceof PasskeyError) || e.code !== 'decrypt-failed' || steps.some((x) => x.startsWith('prf-only'))) throw e;
      prf = (await ask('prf-only', { credentialId: id, readBlob: false, prf: true })).prfFirst;
      words = await openPhrase(payload, { prf, aead: deps.aead });
    }
    return { words, credentialId: id, prf: !!prf, enc: payload.enc };
  } catch (e) {
    throw fail(e, id);
  }
}

// ---------- account hint (iCloud Keychain companion of the phrase) ----------

export type AccountHint = { name?: string; fingerprint?: string; savedAt: number; passkeyAt?: number };

export function parseHint(raw: string | null | undefined): AccountHint | undefined {
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== 'object') return undefined;
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    return { name: str(o.name, 48), fingerprint: str(o.fingerprint, 24), savedAt: num(o.savedAt) ?? 0, passkeyAt: num(o.passkeyAt) };
  } catch {
    return undefined;
  }
}

/** Label of the "Continuer en tant que …" button. */
export function hintLabel(h: AccountHint | undefined): { title: string; action: string; initial?: string; detail?: string } {
  if (h?.name) return { title: h.name, action: `Continuer en tant que ${h.name}`, initial: h.name[0]?.toUpperCase(), detail: h.fingerprint };
  if (h?.fingerprint) return { title: `Compte ${h.fingerprint}`, action: `Continuer avec le compte ${h.fingerprint}` };
  return { title: 'Ton compte Huwa', action: 'Continuer avec ce compte' };
}
