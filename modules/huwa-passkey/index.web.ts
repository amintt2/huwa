// Web build of the HuwaPasskey module: the same contract as the iOS module (index.ts), on
// WebAuthn (navigator.credentials) with the largeBlob and PRF extensions. Bytes are standard
// base64 strings, rejections carry the same `code`s:
// cancelled · no-credentials · unsupported · not-associated · exists · busy · failed.
//
// RP ID = this page's host name (D8): passkeys created by the iOS app belong to huwa.mciut.fr and
// only work there; a self-hosted instance gets passkeys of its own domain.

export type NativeRegisterResult = {
  credentialId: string;
  attestationObject?: string;
  largeBlob: boolean;
  prf: boolean;
  prfFirst?: string;
};

export type NativeAssertion = {
  credentialId: string;
  userHandle: string;
  blob?: string;
  prfFirst?: string;
};

type Native = {
  isSupported(): { passkeys: boolean; largeBlob: boolean; prf: boolean };
  register(o: { userName: string; displayName?: string; userId: string; challenge: string; prfSalt?: string }): Promise<NativeRegisterResult>;
  writeBlob(o: { credentialId: string; challenge: string; data: string }): Promise<{ credentialId: string; written: boolean }>;
  authenticate(o: { challenge: string; credentialId?: string; readBlob?: boolean; prfSalt?: string; immediate?: boolean }): Promise<NativeAssertion>;
  forget(credentialId: string): Promise<boolean>;
  tidy(userId: string, credentialId: string, name?: string): Promise<boolean>;
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toB64(buf: ArrayBuffer | Uint8Array, url = false): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return url ? out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : out;
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.replace(/[\s=]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const out = new Uint8Array(new ArrayBuffer(Math.floor((clean.length * 3) / 4)));
  let bits = 0;
  let value = 0;
  let j = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw coded('failed', 'Base64 invalide');
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (value >> bits) & 255;
    }
  }
  return out;
}

function coded(code: string, message: string, cause?: unknown) {
  const err = new Error(message) as Error & { code: string; cause?: unknown };
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

function mapError(e: unknown): Error {
  const name = (e as { name?: string })?.name;
  const msg = (e as { message?: string })?.message ?? String(e);
  switch (name) {
    case 'NotAllowedError':
      return coded('cancelled', msg, e);
    case 'InvalidStateError':
      return coded('exists', msg, e);
    case 'SecurityError':
      return coded('not-associated', msg, e);
    case 'NotSupportedError':
      return coded('unsupported', msg, e);
    case 'AbortError':
      return coded('busy', msg, e);
    default:
      return coded('failed', msg, e);
  }
}

const rpId = () => location.hostname;

type Ext = {
  largeBlob?: { supported?: boolean; blob?: ArrayBuffer; written?: boolean };
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
};

let busy = false;
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw coded('busy', 'Une demande de clé d’accès est déjà en cours');
  busy = true;
  try {
    return await fn();
  } catch (e) {
    throw (e as { code?: string })?.code ? e : mapError(e);
  } finally {
    busy = false;
  }
}

function available(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials && window.isSecureContext;
}

const web: Native = {
  isSupported() {
    const ok = available();
    // Firefox has no largeBlob; PRF needs Chrome 116+ / Safari 18+ (the flows degrade on errors).
    const firefox = typeof navigator !== 'undefined' && /Firefox\//.test(navigator.userAgent);
    return { passkeys: ok, largeBlob: ok && !firefox, prf: ok };
  },

  register(o) {
    return exclusive(async () => {
      if (!available()) throw coded('unsupported', 'WebAuthn indisponible');
      const cred = (await navigator.credentials.create({
        publicKey: {
          rp: { id: rpId(), name: 'Huwa' },
          user: { id: fromB64(o.userId), name: o.userName, displayName: o.displayName ?? o.userName },
          challenge: fromB64(o.challenge),
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
          extensions: {
            largeBlob: { support: 'preferred' },
            ...(o.prfSalt ? { prf: { eval: { first: fromB64(o.prfSalt) } } } : { prf: {} }),
          } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      if (!cred) throw coded('cancelled', 'Annulé');
      const ext = cred.getClientExtensionResults() as Ext;
      const response = cred.response as AuthenticatorAttestationResponse;
      const prfFirst = ext.prf?.results?.first;
      return {
        credentialId: toB64(cred.rawId),
        attestationObject: response.attestationObject ? toB64(response.attestationObject) : undefined,
        largeBlob: !!ext.largeBlob?.supported,
        prf: !!ext.prf?.enabled || !!prfFirst,
        prfFirst: prfFirst ? toB64(prfFirst) : undefined,
      };
    });
  },

  writeBlob(o) {
    return exclusive(async () => {
      const cred = (await navigator.credentials.get({
        publicKey: {
          rpId: rpId(),
          challenge: fromB64(o.challenge),
          allowCredentials: [{ type: 'public-key', id: fromB64(o.credentialId) }],
          userVerification: 'required',
          extensions: { largeBlob: { write: fromB64(o.data) } } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      if (!cred) throw coded('cancelled', 'Annulé');
      const ext = cred.getClientExtensionResults() as Ext;
      return { credentialId: toB64(cred.rawId), written: !!ext.largeBlob?.written };
    });
  },

  authenticate(o) {
    return exclusive(async () => {
      if (!available()) throw coded('unsupported', 'WebAuthn indisponible');
      const extensions: Record<string, unknown> = {};
      if (o.readBlob) extensions.largeBlob = { read: true };
      if (o.prfSalt) extensions.prf = { eval: { first: fromB64(o.prfSalt) } };
      const cred = (await navigator.credentials.get({
        publicKey: {
          rpId: rpId(),
          challenge: fromB64(o.challenge),
          allowCredentials: o.credentialId ? [{ type: 'public-key', id: fromB64(o.credentialId) }] : [],
          userVerification: 'required',
          extensions: extensions as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      if (!cred) throw coded('no-credentials', 'Aucune clé d’accès');
      const ext = cred.getClientExtensionResults() as Ext;
      const response = cred.response as AuthenticatorAssertionResponse;
      return {
        credentialId: toB64(cred.rawId),
        userHandle: response.userHandle ? toB64(response.userHandle) : '',
        blob: ext.largeBlob?.blob ? toB64(ext.largeBlob.blob) : undefined,
        prfFirst: ext.prf?.results?.first ? toB64(ext.prf.results.first) : undefined,
      };
    });
  },

  async forget(credentialId) {
    // Signal API (Chrome 132+, Safari 26): the password manager may drop the passkey.
    const signal = (PublicKeyCredential as unknown as { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> }).signalUnknownCredential;
    if (!signal) return false;
    await signal({ rpId: rpId(), credentialId: toB64(fromB64(credentialId), true) }).catch(() => {});
    return true;
  },

  async tidy(userId, credentialId, name) {
    const P = PublicKeyCredential as unknown as {
      signalAllAcceptedCredentials?: (o: { rpId: string; userId: string; allAcceptedCredentialIds: string[] }) => Promise<void>;
      signalCurrentUserDetails?: (o: { rpId: string; userId: string; name: string; displayName: string }) => Promise<void>;
    };
    const uid = toB64(fromB64(userId), true);
    if (P.signalAllAcceptedCredentials) await P.signalAllAcceptedCredentials({ rpId: rpId(), userId: uid, allAcceptedCredentialIds: [toB64(fromB64(credentialId), true)] }).catch(() => {});
    if (name && P.signalCurrentUserDetails) await P.signalCurrentUserDetails({ rpId: rpId(), userId: uid, name, displayName: name }).catch(() => {});
    return !!(P.signalAllAcceptedCredentials || P.signalCurrentUserDetails);
  },
};

/** null where WebAuthn is missing (old browsers, plain-http instances). */
export const HuwaPasskey: Native | null = available() ? web : null;

/** WebAuthn relying party of this page (the iOS app uses huwa.mciut.fr). */
export const PASSKEY_RP_ID = typeof location !== 'undefined' ? location.hostname : '';

/** Precise support (client capabilities), when the browser can tell. */
export async function passkeyCapabilities(): Promise<{ passkeys: boolean; largeBlob: boolean; prf: boolean }> {
  const base = web.isSupported();
  const get = (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> } | undefined)?.getClientCapabilities;
  if (!base.passkeys || !get) return base;
  try {
    const caps = await get();
    return { passkeys: base.passkeys, largeBlob: caps['extension:largeBlob'] ?? base.largeBlob, prf: caps['extension:prf'] ?? base.prf };
  } catch {
    return base;
  }
}
