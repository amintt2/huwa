// Web build of ./phrase: the recovery phrase is never persisted in a browser (D6, D7). It stays in
// this tab's memory for the session, so the backup screen can show and verify it right after
// "create an account in this browser", and is gone at the next reload.
let words: string[] | undefined;

export const recoveryPhrase = {
  async get(): Promise<string[] | undefined> {
    return words ? [...words] : undefined;
  },
  async set(w: string[]) {
    words = [...w];
  },
  async forget() {
    words = undefined;
  },
};
