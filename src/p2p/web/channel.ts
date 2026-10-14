// How a tab reaches the browser node (D5):
//   1. SharedWorker (desktop browsers): every tab of the origin gets a port to the same worker;
//   2. otherwise a leader tab, elected with navigator.locks, runs the node in a dedicated Worker
//      and relays the other tabs' messages over a BroadcastChannel (./leader.ts);
//   3. otherwise (no Web Locks) a dedicated Worker per tab; rocksdb-idb's own lock then lets only
//      one of them open the storage, the others fail to start and fall back to the local backend.

export type NodeMessage = { t: string; [k: string]: unknown };

export type NodeChannel = {
  post(msg: NodeMessage, transfer?: Transferable[]): void;
  /** Messages from the node (replies and events). */
  onmessage: ((msg: NodeMessage) => void) | null;
  /** The node behind this channel changed (new leader): resubscribe. */
  onreset: (() => void) | null;
  close(): void;
  readonly kind: 'shared' | 'leader' | 'dedicated';
};

export function supportsBrowserNode(): boolean {
  return typeof Worker !== 'undefined' && typeof indexedDB !== 'undefined' && typeof WebSocket !== 'undefined' && !!globalThis.crypto?.subtle;
}

export function openSharedChannel(url: string): NodeChannel {
  const worker = new SharedWorker(url, { name: 'huwa-node' });
  const port = worker.port;
  const ch: NodeChannel = {
    kind: 'shared',
    onmessage: null,
    onreset: null,
    post: (msg, transfer) => port.postMessage(msg, transfer ?? []),
    close: () => {
      try {
        port.postMessage({ t: 'bye' });
      } catch {
        // already gone
      }
      port.close();
    },
  };
  port.onmessage = (e) => ch.onmessage?.(e.data as NodeMessage);
  port.start();
  return ch;
}

export function openDedicatedChannel(url: string): NodeChannel {
  const worker = new Worker(url, { name: 'huwa-node' });
  const { port1, port2 } = new MessageChannel();
  worker.postMessage({ t: 'port' }, [port2]);
  const ch: NodeChannel = {
    kind: 'dedicated',
    onmessage: null,
    onreset: null,
    post: (msg, transfer) => port1.postMessage(msg, transfer ?? []),
    close: () => worker.terminate(),
  };
  port1.onmessage = (e) => ch.onmessage?.(e.data as NodeMessage);
  port1.start();
  return ch;
}

export async function openNodeChannel(url: string): Promise<NodeChannel> {
  if (typeof SharedWorker !== 'undefined') {
    try {
      return openSharedChannel(url);
    } catch {
      // e.g. SharedWorker blocked in this context: fall through
    }
  }
  if (typeof navigator !== 'undefined' && navigator.locks && typeof BroadcastChannel !== 'undefined') {
    const { openLeaderChannel } = await import('./leader');
    return openLeaderChannel(url);
  }
  return openDedicatedChannel(url);
}
