// Web build of ./bare: keeps react-native-bare-kit and the multi-MB worklet bundle out of the web
// bundle. getP2P() never picks the bare backend on web (src/p2p/index.ts); the browser node lives
// in src/p2p/web/ (docs/WEB_DOCKER_PLAN.md D2). Types still come from ./bare.
import type { BareConfig, BareP2P } from './bare';

export type { BareConfig, BareP2P, RelayStatus } from './bare';

export function createBareP2P(_config: BareConfig): BareP2P {
  throw new Error('Le worklet Bare n’existe pas sur le web');
}

export const _internal = { encoder: new TextEncoder() };
