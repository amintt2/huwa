// Web stand-in for react-native-bare-kit (aliased in metro.config.js for the web platform only).
// Browsers have no Bare runtime: the web P2P node runs in a SharedWorker instead (src/p2p/web/,
// docs/WEB_DOCKER_PLAN.md D2). Constructing a Worklet fails loudly so a caller falls back.
export class Worklet {
  constructor() {
    throw new Error('react-native-bare-kit indisponible sur le web');
  }
}

const BareKit = { Worklet };
export default BareKit;
