/* eslint-disable @typescript-eslint/no-require-imports */
// Browser node worker (docs/WEB_DOCKER_PLAN.md D2, D5): the unchanged HuwaNode
// (src/p2p/worklet/node.js) on rocksdb-idb, reaching HyperDHT through the Huwa gateway with
// @huwa/dht-relay (non-custodial). Bundled by `npm run build:p2p-worker` (packages/p2p-web) into
// public/p2p-worker.js. NOT part of the Metro bundle: the app talks to it through ./client.ts.
//
// Runs as a SharedWorker (one node for every tab of the origin) or, where SharedWorker is missing
// (Safari on iOS, Chrome on Android), as the dedicated Worker of the leader tab (./leader.ts),
// which hands it one MessagePort per tab.
//
// URL parameters: gw = gateway WebSocket URL (default: this origin's /p2p).
import { browserLabel } from './device-name';

type Port = { postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null; start?: () => void };

const { WebSession } = require('./session');
const { createHost } = require('./host');

const scope = self as unknown as {
  location: Location;
  navigator: Navigator & { locks?: LockManager };
  onconnect?: (e: MessageEvent) => void;
  onmessage?: (e: MessageEvent) => void;
  addEventListener: typeof addEventListener;
};

const params = new URL(scope.location.href).searchParams;
const gateway = params.get('gw') || scope.location.origin.replace(/^http/, 'ws') + '/p2p';
const debug = params.get('debug') === '1';
const log = (...a: unknown[]) => {
  if (!debug) return;
  console.log('[huwa-node]', ...a);
  // SharedWorker consoles are hard to reach from tests: mirror to the tabs.
  host?.broadcast({ t: 'event', ev: 'log', data: a.map(String).join(' ') });
};

// Held while a node runs: a tab opened later finds a "public computer" session through
// navigator.locks.query() even though nothing about it was written to disk.
let releaseActive: (() => void) | null = null;
function holdActive(on: boolean) {
  const locks = scope.navigator.locks;
  if (!locks) return;
  if (on && !releaseActive) {
    locks.request('huwa-p2p-active', () => new Promise<void>((resolve) => (releaseActive = resolve))).catch(() => {});
  } else if (!on && releaseActive) {
    releaseActive();
    releaseActive = null;
  }
}

let host: ReturnType<typeof createHost>;
const session = new WebSession({
  gateway,
  deviceName: browserLabel(scope.navigator.userAgent),
  log,
  onevent: (ev: { ev: string }) => host && host.onNodeEvent(ev),
  onnode: (node: unknown) => {
    host.attachNode(node);
    holdActive(!!node);
  },
});
host = createHost(session, { log });

// SharedWorker: one port per tab.
scope.onconnect = (e: MessageEvent) => host.connect(e.ports[0] as unknown as Port);
// Dedicated worker of the leader tab: ports arrive in { t: 'port' } messages.
scope.onmessage = (e: MessageEvent) => {
  if (e.data && e.data.t === 'port' && e.ports[0]) host.connect(e.ports[0] as unknown as Port);
};

session.init().catch((err: Error) => log('init failed', err && err.message));

// Test hooks (Playwright): the node of this worker, only with ?debug=1.
if (debug) (self as unknown as { __huwa: unknown }).__huwa = { session, host };
