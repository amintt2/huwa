// "Verrouiller avec une passkey" (D6): the browser's at-rest key (keystore.js) is wrapped by a
// key derived from a WebAuthn PRF output, so the account on this computer opens only after the
// passkey's user verification (Touch ID, Windows Hello, phone). Separate from the passkey that
// carries the account (src/p2p/passkey.ts): this one only unlocks this browser.
import { webSession } from '../index';

const SALT_LABEL = 'huwa-web-lock-v1';
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function passkeyLockSupported(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && window.isSecureContext;
}

/**
 * Non-extractable AES-GCM key-encryption key from a PRF output. Same derivation as
 * keystore.js `kekFromPrf` (HKDF-SHA256, salt "huwa-web-lock-v1", info "huwa/web/kek/v1").
 */
export async function kekFromPrf(prf: ArrayBuffer | Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', prf as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(SALT_LABEL), info: enc.encode('huwa/web/kek/v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
}

function coded(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

/** WebAuthn DOMException -> coded error (same codes as modules/huwa-passkey). */
function mapError(e: unknown): Error {
  if ((e as { code?: unknown })?.code && typeof (e as { code?: unknown }).code === 'string') return e as Error;
  const name = (e as { name?: string })?.name;
  const message = (e as { message?: string })?.message ?? String(e);
  const code = name === 'NotAllowedError' ? 'cancelled' : name === 'InvalidStateError' ? 'exists' : name === 'SecurityError' ? 'not-associated' : name === 'NotSupportedError' ? 'unsupported' : name === 'AbortError' ? 'busy' : 'failed';
  return coded(code, message);
}

async function mapped<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw mapError(e);
  }
}

function prfOf(credentialId: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  return mapped(prfOfRaw(credentialId, salt));
}

async function prfOfRaw(credentialId: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      rpId: location.hostname,
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const first = (cred?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } } | undefined)?.prf?.results?.first;
  if (!first) throw coded('prf-unavailable', 'Cette clé d’accès ne peut pas verrouiller Huwa (extension PRF absente).');
  return first;
}

function session() {
  const w = webSession();
  if (!w) throw coded('unsupported', 'Indisponible');
  return w;
}

/** Creates a passkey for this browser and moves the account key behind it. */
export async function enablePasskeyLock(label: string) {
  if (!passkeyLockSupported()) throw coded('unsupported', 'Les clés d’accès ne sont pas disponibles ici.');
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const cred = (await mapped(navigator.credentials.create({
    publicKey: {
      rp: { id: location.hostname, name: 'Huwa' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `Huwa · ${label}`, displayName: `Huwa · ${label}` },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  }))) as PublicKeyCredential | null;
  if (!cred) throw coded('cancelled', 'Annulé');
  const id = new Uint8Array(cred.rawId);
  const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };
  if (ext.prf && ext.prf.enabled === false) throw coded('prf-unavailable', 'Ce gestionnaire de clés d’accès ne gère pas le verrouillage (PRF).');
  // Some authenticators only evaluate PRF on get().
  const prf = ext.prf?.results?.first ?? (await prfOf(id, salt));
  const kek = await kekFromPrf(prf);
  return session().enablePasskey(kek, { credentialId: b64url(id), prfSalt: b64url(salt) });
}

/** Unlocks a locked session (passkey prompt). */
export async function unlockWithPasskey() {
  const w = session();
  const p = w.session().passkey;
  if (!p) throw coded('no-passkey', 'Aucune clé d’accès ne verrouille cette session.');
  const kek = await kekFromPrf(await prfOf(fromB64url(p.credentialId), fromB64url(p.prfSalt)));
  return w.unlock(kek);
}

/** Back to the browser-kept key (one more passkey prompt to read the account key). */
export async function disablePasskeyLock() {
  const w = session();
  const p = w.session().passkey;
  if (!p) return w.session();
  const kek = await kekFromPrf(await prfOf(fromB64url(p.credentialId), fromB64url(p.prfSalt)));
  return w.disablePasskey(kek);
}
