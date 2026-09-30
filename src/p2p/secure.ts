// Secrets (recovery phrase, root seed) live in the iOS Keychain / Android Keystore via
// expo-secure-store, never in AsyncStorage. `THIS_DEVICE_ONLY`: excluded from backups;
// cloud backup of the phrase is an explicit, separate feature (PLAN §2).
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
// Web has no keychain: dev-only fallback.
const WEB = Platform.OS === 'web';

export const secure = {
  get: (k: string) => (WEB ? AsyncStorage.getItem(`huwa/secure/${k}`) : SecureStore.getItemAsync(k, OPTS)),
  set: (k: string, v: string) => (WEB ? AsyncStorage.setItem(`huwa/secure/${k}`, v) : SecureStore.setItemAsync(k, v, OPTS)),
  del: (k: string) => (WEB ? AsyncStorage.removeItem(`huwa/secure/${k}`) : SecureStore.deleteItemAsync(k, OPTS)),
};

/** Cryptographically secure random bytes (SecRandomCopyBytes / SecureRandom). */
export const randomBytes = (n: number): Uint8Array => Crypto.getRandomBytes(n);
