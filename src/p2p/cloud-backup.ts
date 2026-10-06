// Recovery phrase copy in iCloud Keychain (iOS). The item is synchronizable, so iOS syncs it
// end-to-end encrypted to the user's other Apple devices; neither Huwa nor Apple can read it.
// On by default where available; the user can switch it off in Réglages → Sécurité, which also
// deletes the copy. Android (Block Store) is not implemented yet: `supported` is false there.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { HuwaKeychain } from '../../modules/huwa-keychain';

import { parseHint, type AccountHint } from './passkey-core';
import { recoveryPhrase } from './phrase';

const ITEM = 'recovery-phrase';
// Companion item: who the phrase belongs to (pseudo, fingerprint), so a new device can offer
// "Continuer en tant que …" without deriving anything. Synchronizable like the phrase, no secret.
const HINT = 'account-hint';
const PREF = 'huwa/cloud-backup/v1';

/** Profile bits written next to the phrase. */
export type HintPatch = Partial<Omit<AccountHint, 'savedAt'>>;
let lastHint: AccountHint | undefined;
let hintWrite: Promise<void> = Promise.resolve();

/** Serialized read-merge-write of the hint (never throws: the hint is a nicety). */
function writeHint(patch: HintPatch) {
  hintWrite = hintWrite.then(async () => {
    if (!cloudBackupSupported) return;
    if (!lastHint) lastHint = parseHint(await HuwaKeychain!.get(HINT).catch(() => null));
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next: AccountHint = { ...lastHint, ...defined, savedAt: lastHint?.savedAt ?? 0 };
    const same = lastHint && JSON.stringify({ ...lastHint, savedAt: 0 }) === JSON.stringify({ ...next, savedAt: 0 });
    if (same) return;
    next.savedAt = Date.now();
    await HuwaKeychain!.set(HINT, JSON.stringify(next)).then(() => {
      lastHint = next;
    }, () => {});
  });
  return hintWrite;
}

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
      // A corrupt preference must not wedge every later call (they all await this promise).
      let enabled = true;
      try {
        const v = raw ? (JSON.parse(raw) as { enabled?: unknown }) : null;
        if (typeof v?.enabled === 'boolean') enabled = v.enabled;
      } catch {
        // keep the default
      }
      let saved = cloudBackupSupported ? !!(await HuwaKeychain!.get(ITEM).catch(() => null)) : false;
      // Accounts created before this feature (or while it was off then on): back up the phrase
      // this device already holds. Devices linked by QR never had the phrase: nothing to copy.
      if (cloudBackupSupported && enabled && !saved) {
        const words = await recoveryPhrase.get().catch(() => undefined);
        if (words) saved = await HuwaKeychain!.set(ITEM, words.join(' ')).then(() => true, () => false);
      }
      emit({ enabled, saved });
    })().catch(() => emit({}));
  }
  return hydrated;
}

export const cloudBackup = {
  /** Loads the preference and backs up an existing phrase if needed (app start). */
  init: () => hydrate(),
  /** Saves the phrase when the backup is on (called after creating or restoring an identity). */
  async save(words: string[], hint?: HintPatch) {
    await hydrate();
    if (!cloudBackupSupported || !state.enabled) return false;
    await HuwaKeychain!.set(ITEM, words.join(' '));
    emit({ saved: true });
    if (hint) {
      // Same account (restore on a new device): keep what other devices wrote (name, passkey).
      // Another account was there before: start the hint from scratch.
      await hintWrite;
      const current = parseHint(await HuwaKeychain!.get(HINT).catch(() => null));
      lastHint = current?.fingerprint && current.fingerprint === hint.fingerprint ? current : { savedAt: 0 };
      await writeHint(hint);
    }
    return true;
  },
  /** Phrase found in iCloud Keychain (e.g. on a new iPhone signed in to the same Apple account). */
  async load(): Promise<string[] | undefined> {
    if (!cloudBackupSupported) return undefined;
    const raw = await HuwaKeychain!.get(ITEM).catch(() => null);
    return raw ? raw.trim().split(/\s+/) : undefined;
  },
  /** Who the iCloud phrase belongs to, when known. */
  async loadHint(): Promise<AccountHint | undefined> {
    if (!cloudBackupSupported) return undefined;
    return parseHint(await HuwaKeychain!.get(HINT).catch(() => null));
  },
  /**
   * The hint of `words` when they are the phrase saved in iCloud Keychain (the hint is written
   * next to that phrase, whatever path the words came from: typed, passkey or iCloud).
   */
  async hintFor(words: string[]): Promise<AccountHint | undefined> {
    const saved = await cloudBackup.load().catch(() => undefined);
    if (!saved || saved.join(' ').toLowerCase() !== words.map((w) => w.trim().toLowerCase()).join(' ')) return undefined;
    return cloudBackup.loadHint().catch(() => undefined);
  },
  /** Keeps the hint in step with the profile (name change, passkey created). No-op when the backup is off. */
  async syncHint(patch: HintPatch) {
    await hydrate();
    if (!cloudBackupSupported || !state.enabled || !state.saved) return;
    await writeHint(patch);
  },
  async setEnabled(enabled: boolean, words: string[] | undefined = undefined) {
    await hydrate();
    await AsyncStorage.setItem(PREF, JSON.stringify({ enabled })).catch(() => {});
    emit({ enabled });
    if (!cloudBackupSupported) return;
    if (!enabled) {
      await HuwaKeychain!.remove(ITEM);
      await HuwaKeychain!.remove(HINT).catch(() => {});
      lastHint = undefined;
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
