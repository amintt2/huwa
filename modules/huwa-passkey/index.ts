import { requireOptionalNativeModule } from 'expo-modules-core';

// Bytes are standard base64 strings. Rejections carry `code`:
// cancelled · no-credentials · unsupported · not-associated · exists · busy · failed.
// Android: not implemented yet (Credential Manager would be the way), the module is null there.

export type NativeRegisterResult = {
  credentialId: string;
  attestationObject?: string;
  /** The provider accepted largeBlob (iCloud Keychain on iOS 17+, others vary). */
  largeBlob: boolean;
  prf: boolean;
  /** PRF output evaluated at creation, when the provider supports it (iOS 18+). */
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

/** null on Android / web / builds without the module. */
export const HuwaPasskey = requireOptionalNativeModule<Native>('HuwaPasskey');
