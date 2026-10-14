// "Ordinateur public" choice of the web login screens (D6): shared by the hub, the QR link, the
// phrase and the passkey flows. Kept in memory only: a public computer must not remember it either.
import { useSyncExternalStore } from 'react';

export type LoginMode = 'device' | 'memory';

let mode: LoginMode = 'device';
const listeners = new Set<() => void>();

export const getLoginMode = (): LoginMode => mode;

export function setPublicComputer(on: boolean) {
  const next: LoginMode = on ? 'memory' : 'device';
  if (next === mode) return;
  mode = next;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Storage of the next login: `memory` = "Ordinateur public" (nothing written to this computer). */
export function useLoginMode(): { mode: LoginMode; publicComputer: boolean; setPublicComputer: (on: boolean) => void } {
  const m = useSyncExternalStore(subscribe, getLoginMode, getLoginMode);
  return { mode: m, publicComputer: m === 'memory', setPublicComputer };
}
