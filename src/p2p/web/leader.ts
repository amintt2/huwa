// Fallback for browsers without SharedWorker (D5): one tab, elected with navigator.locks, runs the
// node in a dedicated Worker; the other tabs talk to it over a BroadcastChannel. When the leader
// tab goes away its lock is released, the next tab in the lock queue starts its own Worker (the
// node reopens from IndexedDB: rocksdb-idb's Web Lock guarantees the old one is gone first) and
// announces itself; followers then resubscribe (NodeChannel.onreset).
//
// Bus messages:  follower -> leader  { t: 'call' | 'bye', from, ... }
//                leader -> follower  { to, msg }   (to = tab id, or '*' for every follower)
//                leader announces    { t: 'leader', id }
import type { NodeChannel, NodeMessage } from './channel';

const LOCK = 'huwa-node-leader';
const BUS = 'huwa-node-bus';

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

export function openLeaderChannel(url: string): NodeChannel {
  const id = randomId();
  const bus = new BroadcastChannel(BUS);
  let leader = false;
  let worker: Worker | null = null;
  let own: MessagePort | null = null;
  const followers = new Map<string, MessagePort>();
  let closed = false;
  let release: (() => void) | null = null;
  // Messages posted before this tab knows whether it leads.
  let queue: { msg: NodeMessage; transfer?: Transferable[] }[] | null = [];
  const flush = () => {
    const q = queue;
    queue = null;
    for (const { msg, transfer } of q ?? []) ch.post(msg, transfer);
  };

  const ch: NodeChannel = {
    kind: 'leader',
    onmessage: null,
    onreset: null,
    post(msg, transfer) {
      if (closed) return;
      if (queue) {
        queue.push({ msg, transfer });
        return;
      }
      if (leader && own) own.postMessage(msg, transfer ?? []);
      // CryptoKeys are structured-cloneable over a BroadcastChannel too.
      else bus.postMessage({ ...msg, from: id });
    },
    close() {
      if (closed) return;
      closed = true;
      if (!leader) bus.postMessage({ t: 'bye', from: id });
      bus.close();
      worker?.terminate();
      release?.();
    },
  };

  function portFor(from: string): MessagePort {
    let port = followers.get(from);
    if (port) return port;
    const { port1, port2 } = new MessageChannel();
    worker!.postMessage({ t: 'port' }, [port2]);
    port1.onmessage = (e) => bus.postMessage({ to: from, msg: e.data });
    port1.start();
    followers.set(from, port1);
    return port1;
  }

  bus.onmessage = (e) => {
    const m = e.data as NodeMessage & { from?: string; to?: string; msg?: NodeMessage; id?: string };
    if (leader) {
      if (typeof m.from !== 'string' || m.from === id) return;
      if (m.t === 'bye') {
        const port = followers.get(m.from);
        port?.postMessage({ t: 'bye' });
        port?.close();
        followers.delete(m.from);
        return;
      }
      const { from, ...rest } = m;
      portFor(from).postMessage(rest);
      return;
    }
    if (m.t === 'leader' && m.id !== id) {
      ch.onreset?.();
      return;
    }
    if (m.to === id && m.msg) ch.onmessage?.(m.msg);
  };

  function becomeLeader() {
    leader = true;
    worker = new Worker(url, { name: 'huwa-node' });
    const { port1, port2 } = new MessageChannel();
    worker.postMessage({ t: 'port' }, [port2]);
    port1.onmessage = (e) => ch.onmessage?.(e.data as NodeMessage);
    port1.start();
    own = port1;
    bus.postMessage({ t: 'leader', id });
    flush();
  }

  // Queued: granted at once when there is no leader, later when the current leader goes away.
  navigator.locks
    .request(LOCK, () => {
      if (closed) return undefined;
      const wasFollower = queue === null; // already talked to a previous leader
      becomeLeader();
      if (wasFollower) queueMicrotask(() => ch.onreset?.());
      return new Promise<void>((resolve) => (release = resolve));
    })
    .catch(() => {});
  // Somebody else already leads: talk to it right away.
  navigator.locks
    .query()
    .then((state) => {
      if (queue && (state.held ?? []).some((l) => l.name === LOCK) && !leader) flush();
    })
    .catch(() => flush());

  return ch;
}
