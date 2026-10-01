// « Supprimer mon compte » (Réglages → Sécurité), App Store guideline 5.1.1(v). Huwa has no
// server account: deleting it means erasing everything this device holds — progress, lists,
// settings, downloads, the identity's secrets (Keychain) and the P2P store — and, if the user
// agrees, the iCloud Keychain copy of the recovery phrase. What can't be done from here (passkey in
// the password manager, data already replicated by peers) is explained by the screen.
//
// The P2P store (Documents/huwa-p2p*) is open by the running worklet: it is deleted at the next
// launch, before the P2P layer starts (`finishPendingDeletion`, imported first by the root layout),
// and the app restarts (or asks to be closed) right after the wipe.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import * as Updates from 'expo-updates';
import { DevSettings, Platform } from 'react-native';

import { PROVIDERS } from '@/debrid/providers';
import { isDemo } from '@/demo/flags';
import { cloudBackup } from '@/p2p/cloud-backup';
import { secure } from '@/p2p/secure';
import { cancelPendingWrites } from '@/store/persist';

const MARKER = '.huwa-account-deleted';
/** Directories of the P2P worklet (identity, comments, messages, stats). */
const P2P_DIRS = ['huwa-p2p', 'huwa-p2p-stats'];
const SECRETS = [
  'huwa.identity.phrase',
  'huwa.identity.root',
  'huwa.device.seed',
  'huwa.ui.recovery-phrase',
  'huwa.debrid.provider',
  ...Object.keys(PROVIDERS).map((id) => `huwa.debrid.key.${id}`),
];

const native = Platform.OS !== 'web' && !isDemo;

/** Synchronous: runs at startup, before anything opens the P2P store. */
export function finishPendingDeletion() {
  if (!native) return;
  try {
    const marker = new File(Paths.document, MARKER);
    if (!marker.exists) return;
    for (const name of P2P_DIRS) {
      const dir = new Directory(Paths.document, name);
      if (dir.exists) dir.delete();
    }
    marker.delete();
  } catch {
    // retried at the next launch (the marker stays)
  }
}

export type DeleteResult = { restarted: boolean };

export async function deleteAccount({ removeCloudCopy }: { removeCloudCopy: boolean }): Promise<DeleteResult> {
  // Nothing in memory may be written back after the wipe.
  cancelPendingWrites();
  if (removeCloudCopy) await cloudBackup.setEnabled(false).catch(() => {});

  await Promise.all(
    SECRETS.map(async (k) => {
      await secure.del(k).catch(() => {});
      await SecureStore.deleteItemAsync(k).catch(() => {});
    }),
  );

  const keys = await AsyncStorage.getAllKeys().catch(() => [] as readonly string[]);
  await AsyncStorage.multiRemove([...keys]).catch(() => {});

  if (native) {
    try {
      new File(Paths.document, MARKER).create({ overwrite: true });
    } catch {
      // without the marker the P2P store survives: the next attempt retries
    }
    for (const root of [Paths.document, Paths.cache]) {
      try {
        for (const entry of new Directory(root).list()) {
          if (entry.name === MARKER || P2P_DIRS.includes(entry.name)) continue;
          try {
            entry.delete();
          } catch {
            // in use: the OS cleans the cache, downloads go with the app
          }
        }
      } catch {
        // folder unreadable
      }
    }
  }

  cancelPendingWrites();
  if (isDemo) return { restarted: false };
  // Restart on a clean slate (deletes the P2P store first, see above).
  if (__DEV__) {
    DevSettings.reload();
    return { restarted: true };
  }
  try {
    await Updates.reloadAsync();
    return { restarted: true };
  } catch {
    return { restarted: false };
  }
}
