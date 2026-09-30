// Recovery phrase copy in iCloud Keychain (iOS). The item is synchronizable, so iOS syncs it
// end-to-end encrypted to the user's other Apple devices; neither Huwa nor Apple can read it.
// On by default where available; the user can switch it off in Réglages → Sécurité, which also
// deletes the copy. Android (Block Store) is not implemented yet: `supported` is false there.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { HuwaKeychain } from '../../modules/huwa-keychain';

import { recoveryPhrase } from './phrase';

const ITEM = 'recovery-phrase';
const PREF = 'huwa/cloud-backup/v1';

type State = { enabled: boolean; saved: boolean };
let state: State = { enabled: true, saved: false };
let hydrated: Promise<void> | undefined;
const listeners = new Set<() => void>();
const emit = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export const cloudBackupSupported = !!HuwaKeychain;

function hydrate() {
  if (!hydrated) {
    hydrated = (async () => {
      const raw = await AsyncStorage.getItem(PREF).catch(() => null);
      const enabled = raw ? (JSON.parse(raw) as { enabled: boolean }).enabled : true;
      let saved = cloudBackupSupported ? !!(await HuwaKeychain!.get(ITEM).catch(() => null)) : false;
      // Accounts created before this feature (or while it was off then on): back up the phrase
      // this device already holds. Devices linked by QR never had the phrase: nothing to copy.
      if (cloudBackupSupported && enabled && !saved) {
        const words = await recoveryPhrase.get();
        if (words) saved = await HuwaKeychain!.set(ITEM, words.join(' ')).then(() => true, () => false);
      }
      emit({ enabled, saved });
    })();
  }
  return hydrated;
}

export const cloudBackup = {
  /** Loads the preference and backs up an existing phrase if needed (app start). */
  init: () => hydrate(),
  /** Saves the phrase when the backup is on (called after creating or restoring an identity). */
  async save(words: string[]) {
    await hydrate();
    if (!cloudBackupSupported || !state.enabled) return false;
    await HuwaKeychain!.set(ITEM, words.join(' '));
    emit({ saved: true });
    return true;
  },
  /** Phrase found in iCloud Keychain (e.g. on a new iPhone signed in to the same Apple account). */
  async load(): Promise<string[] | undefined> {
    if (!cloudBackupSupported) return undefined;
    const raw = await HuwaKeychain!.get(ITEM).catch(() => null);
    return raw ? raw.trim().split(/\s+/) : undefined;
  },
  async setEnabled(enabled: boolean, words: string[] | undefined = undefined) {
    await hydrate();
    await AsyncStorage.setItem(PREF, JSON.stringify({ enabled })).catch(() => {});
    emit({ enabled });
    if (!cloudBackupSupported) return;
    if (!enabled) {
      await HuwaKeychain!.remove(ITEM);
      emit({ saved: false });
    } else {
      const phrase = words ?? (await recoveryPhrase.get());
      if (phrase) {
        await HuwaKeychain!.set(ITEM, phrase.join(' '));
        emit({ saved: true });
      }
    }
  },
};

export function useCloudBackup() {
  const [, force] = useState(0);
  useEffect(() => {
    hydrate().then(() => force((n) => n + 1));
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}
