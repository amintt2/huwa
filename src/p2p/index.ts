// Provisional entry point: local implementation only. The `bare` branch replaces this
// file with the worklet-backed selection (same `getP2P()` signature).
import type { P2P } from './contract';
import { createLocalP2P } from './local';

let instance: P2P | undefined;

export function getP2P(): P2P {
  instance ??= createLocalP2P();
  return instance;
}

export type * from './contract';
