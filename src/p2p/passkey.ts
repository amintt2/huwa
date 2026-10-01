// App side of the passkey that carries the account (logic and tests in passkey-core.ts).
// Native module: modules/huwa-passkey (iOS 17+, PRF on iOS 18+). Android: not available yet.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto';
import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { HuwaPasskey } from '../../modules/huwa-passkey';
import { isValidPhrase } from '@/social/identity';

import { cloudBackup } from './cloud-backup';
import type { Profile } from './contract';
import { social } from './hooks';
import {
  PasskeyError,
  fromBase64,
  loginWithPasskey,
  setupPasskey,
  toBase64,
  userIdFor,
  type Aead,
  type PasskeyNative,
  type PasskeyRecord,
  type SetupStep,
} from './passkey-core';
import { recoveryPhrase } from './phrase';
import { randomBytes } from './secure';

export { PasskeyError, type PasskeyRecord, type SetupStep } from './passkey-core';

// ---------- support ----------

const caps = (() => {
  try {
    return HuwaPasskey?.isSupported();
  } catch {
    return undefined;
  }
})();

/** Passkeys that can carry the account: iOS 17+ (largeBlob). PRF (encryption) needs iOS 18. */
export const passkeySupport = {
  available: !!caps?.largeBlob,
  prf: !!caps?.prf,
  /** Why it is not available, for the settings row. */
  reason: caps?.largeBlob ? undefined : Platform.OS === 'android' ? 'Bientôt disponible sur Android' : Platform.OS === 'ios' && HuwaPasskey ? 'Nécessite iOS 17 ou plus récent' : 'Indisponible sur cet appareil',
};

// ---------- native + crypto adapters ----------

const aead: Aead = {
  async seal(key, nonce, plaintext, aad) {
    const k = await AESEncryptionKey.import(key);
    const sealed = await aesEncryptAsync(plaintext, k, { nonce: { bytes: nonce }, additionalData: aad });
    return sealed.ciphertext({ includeTag: true });
  },
  async open(key, nonce, sealed, aad) {
    const k = await AESEncryptionKey.import(key);
    return aesDecryptAsync(AESSealedData.fromParts(nonce, sealed, 16), k, { additionalData: aad });
  },
};

const b64 = (s: string | undefined | null) => (s ? fromBase64(s) : undefined);

function nativeAdapter(): PasskeyNative {
  const n = HuwaPasskey;
  if (!n || !passkeySupport.available) throw new PasskeyError('unsupported', passkeySupport.reason ?? 'Indisponible');
  return {
    async register(o) {
      const r = await n.register({ userName: o.userName, displayName: o.displayName, userId: toBase64(o.userId), challenge: toBase64(o.challenge), prfSalt: toBase64(o.prfSalt) });
      return { credentialId: r.credentialId, attestationObject: b64(r.attestationObject), largeBlob: r.largeBlob, prf: r.prf, prfFirst: b64(r.prfFirst) };
    },
    async writeBlob(o) {
      return n.writeBlob({ credentialId: o.credentialId, challenge: toBase64(o.challenge), data: toBase64(o.data) });
    },
    async authenticate(o) {
      const a = await n.authenticate({
        challenge: toBase64(o.challenge),
        credentialId: o.credentialId,
        readBlob: o.readBlob,
        prfSalt: o.prfSalt && passkeySupport.prf ? toBase64(o.prfSalt) : undefined,
        immediate: o.immediate,
      });
      return { credentialId: a.credentialId, userHandle: b64(a.userHandle), blob: b64(a.blob), prfFirst: b64(a.prfFirst) };
    },
  };
}

// ---------- local record (no secret: id, date, flags) ----------

const KEY = 'huwa/passkey/v1';
let record: PasskeyRecord | null | undefined;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();
const setRecord = async (r: PasskeyRecord | null) => {
  record = r;
  listeners.forEach((l) => l());
  await (r ? AsyncStorage.setItem(KEY, JSON.stringify(r)) : AsyncStorage.removeItem(KEY)).catch(() => {});
};
function load() {
  if (!loading) {
    loading = AsyncStorage.getItem(KEY)
      .then((raw) => (raw ? (JSON.parse(raw) as PasskeyRecord) : null))
      .catch(() => null)
      .then((r) => {
        if (record === undefined) record = r;
        listeners.forEach((l) => l());
      });
  }
  return loading;
}

/** Passkey set up for this identity (undefined while loading, null when none). */
export function usePasskeyRecord(identity: string | undefined): PasskeyRecord | null | undefined {
  useEffect(() => {
    load();
  }, []);
  const r = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => record,
    () => record,
  );
  if (r === undefined) return undefined;
  return r && identity && r.identity === identity ? r : null;
}

// ---------- actions ----------

/** The phrase on this device, else the iCloud Keychain copy (devices linked by QR have neither). */
async function phraseForPasskey(): Promise<string[] | undefined> {
  const local = await recoveryPhrase.get().catch(() => undefined);
  if (local && isValidPhrase(local)) return local;
  const cloud = await cloudBackup.load().catch(() => undefined);
  return cloud && isValidPhrase(cloud) ? cloud : undefined;
}

export const canCarryAccount = async () => !!(await phraseForPasskey());

export async function createPasskey(me: Profile, onStep?: (s: SetupStep) => void): Promise<PasskeyRecord> {
  const words = await phraseForPasskey();
  if (!words) throw new PasskeyError('failed', 'Ta phrase de récupération n’est pas sur cet appareil : crée la clé d’accès depuis l’appareil où tu as créé ton compte.');
  const native = nativeAdapter();
  try {
    const rec = await setupPasskey(me, words, { native, aead, random: randomBytes, now: Date.now, onStep });
    await setRecord(rec);
    cloudBackup.syncHint({ passkeyAt: rec.createdAt }).catch(() => {});
    // iOS 26+: drop older passkeys of this account in the manager, keep the displayed name current.
    HuwaPasskey?.tidy(toBase64(userIdFor(me.key)), rec.credentialId, `${me.name} · ${me.fingerprint}`).catch(() => {});
    return rec;
  } catch (e) {
    // A passkey that cannot hold the account is useless: ask the manager to forget it (iOS 26+).
    if (e instanceof PasskeyError && e.code === 'no-large-blob' && e.credentialId) HuwaPasskey?.forget(e.credentialId).catch(() => {});
    throw e;
  }
}

/** Onboarding: passkey → blob → phrase → same restore path as typing the phrase. */
export async function restoreWithPasskey(opts: { immediate?: boolean } = {}): Promise<Profile> {
  const login = await loginWithPasskey({ native: nativeAdapter(), aead, random: randomBytes }, opts);
  const profile = await social.restoreIdentity(login.words);
  await setRecord({ credentialId: login.credentialId, identity: profile.key, createdAt: Date.now(), largeBlob: true, prf: login.prf, enc: login.enc });
  return profile;
}

/** French message for an error, or undefined when nothing should be shown (user cancelled). */
export function passkeyMessage(e: unknown): string | undefined {
  const code = e instanceof PasskeyError ? e.code : (e as { code?: string })?.code;
  switch (code) {
    case 'cancelled':
      return undefined;
    case 'no-credentials':
      return 'Aucune clé d’accès Huwa sur cet appareil.';
    case 'unsupported':
      return passkeySupport.reason ?? 'Les clés d’accès ne sont pas disponibles sur cet appareil.';
    case 'not-associated':
      return 'Les clés d’accès ne sont pas encore activées pour cette version de Huwa.';
    case 'exists':
      return 'Une clé d’accès existe déjà pour ce compte dans ce gestionnaire.';
    case 'busy':
      return 'Une demande est déjà en cours.';
    case 'no-blob':
      return 'Cette clé d’accès ne contient pas de compte Huwa : son gestionnaire de mots de passe ne peut pas le transporter. Utilise ta phrase ou le Trousseau iCloud.';
    case 'prf-unavailable':
      return 'Ce compte est chiffré dans la clé d’accès, et ce gestionnaire ne peut pas la déverrouiller ici (iOS 18 requis).';
    case 'decrypt-failed':
    case 'bad-blob':
      return 'Le contenu de cette clé d’accès est illisible.';
    case 'write-failed':
      return 'Le gestionnaire n’a pas pu enregistrer ton compte dans la clé d’accès. Réessaie.';
    default:
      return e instanceof Error && e.message ? e.message : 'La clé d’accès n’a pas fonctionné.';
  }
}

// ---------- "Ajoute une clé d'accès" after creating / restoring an account ----------

let offerPending = false;
const offerListeners = new Set<() => void>();

/** Called right before creating or restoring an account (not when restoring *with* a passkey). */
export function requestPasskeyOffer(on = true) {
  offerPending = on && passkeySupport.available;
  offerListeners.forEach((l) => l());
}

export function usePasskeyOfferPending() {
  return useSyncExternalStore(
    (l) => {
      offerListeners.add(l);
      return () => offerListeners.delete(l);
    },
    () => offerPending,
    () => offerPending,
  );
}

export const consumePasskeyOffer = () => requestPasskeyOffer(false);
