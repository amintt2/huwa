// The contract returns the recovery phrase only once (createIdentity). The UI keeps it in
// the Keychain (this device only, never synced) so it can be shown and verified later,
// after the first uses (PLAN §2), then optionally forgotten.
import { secure } from './secure';

const KEY = 'huwa.ui.recovery-phrase';

export const recoveryPhrase = {
  async get(): Promise<string[] | undefined> {
    const raw = await secure.get(KEY).catch(() => null);
    return raw ? raw.split(' ') : undefined;
  },
  set: (words: string[]) => secure.set(KEY, words.join(' ')),
  forget: () => secure.del(KEY),
};
