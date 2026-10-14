// Test page of the browser node (bundled by e2e/harness.mjs): the real client (src/p2p/web/
// client.ts) and the real link-web logic, driven by Playwright through `window.huwa`.
import { createWebP2P, type WebP2P } from '../../../src/p2p/web/client';
import { browserLabel } from '../../../src/p2p/web/device-name';
import { buildLinkUrl, newLinkKeys, newTopic, waitLinkFrame, webCryptoAead } from '../../../src/p2p/link-web';
import type { P2PComment } from '../../../src/p2p/contract';

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const relay = location.origin + '/p2p';

let p2p: WebP2P | null = null;
let link: Promise<unknown> | null = null;
const comments = new Map<string, P2PComment[]>();

function client() {
  const dedicated = location.search.includes('channel=dedicated');
  if (!p2p) p2p = createWebP2P({ workerUrl: '/p2p-worker.js?debug=1', channel: dedicated ? 'dedicated' : undefined });
  return p2p;
}

async function idbContains(needles: string[]) {
  const enc = new TextEncoder();
  const targets = needles.map((n) => enc.encode(n));
  const found = new Set<string>();
  const check = (bytes: Uint8Array) => {
    targets.forEach((t, i) => {
      outer: for (let s = 0; s <= bytes.length - t.length; s++) {
        for (let j = 0; j < t.length; j++) if (bytes[s + j] !== t[j]) continue outer;
        found.add(needles[i]);
        break;
      }
    });
  };
  const names = (await indexedDB.databases()).map((d) => d.name!).filter(Boolean);
  for (const name of names) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    for (const store of Array.from(db.objectStoreNames)) {
      const values = await new Promise<unknown[]>((resolve) => {
        const r = db.transaction(store).objectStore(store).getAll();
        r.onsuccess = () => resolve(r.result);
      });
      for (const v of values) {
        if (v instanceof Uint8Array || v instanceof ArrayBuffer) check(new Uint8Array(v as ArrayBuffer));
        else check(enc.encode(JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? Array.from(x) : x)) ?? ''));
      }
    }
    db.close();
  }
  for (const s of [localStorage, sessionStorage]) for (let i = 0; i < s.length; i++) check(enc.encode(s.getItem(s.key(i)!) ?? ''));
  return { databases: names, found: [...found] };
}

const api = {
  label: () => browserLabel(),
  async ready() {
    await client().ready;
    return client().session();
  },
  session: () => client().session(),
  me: () => client().me() ?? null,
  status: () => client().status(),
  async hello() {
    await client().connect();
    return { session: client().session(), me: client().me() ?? null };
  },
  /** QR link: returns the QR URL at once; `linkDone()` resolves with the profile. */
  startLink(mode: 'device' | 'memory') {
    const keys = newLinkKeys(random);
    const topic = newTopic(random);
    const url = buildLinkUrl({ key: keys.publicKey, relay, topic, name: browserLabel() });
    const t0 = performance.now();
    link = (async () => {
      const c = client();
      c.setLoginMode(mode);
      const starting = c.begin({ mode });
      const payload = await waitLinkFrame({ relay, topic }, keys, { aead: webCryptoAead, ms: 120_000 });
      const tInvite = performance.now() - t0;
      await starting;
      const t1 = performance.now();
      const me = await c.acceptPairing(payload.invite);
      return { me, inviteMs: tInvite, pairingMs: performance.now() - t1, totalMs: performance.now() - t0 };
    })();
    link.catch(() => {});
    return url;
  },
  linkDone: () => link,
  async restore(words: string[], mode: 'device' | 'memory') {
    client().setLoginMode(mode);
    return client().restoreIdentity(words);
  },
  async create(name: string, mode: 'device' | 'memory') {
    client().setLoginMode(mode);
    return client().createIdentity(name);
  },
  async comment(work: string, text: string) {
    const t = performance.now();
    const c = await client().postComment({ target: 'ep:' + work + '-e1', text, spoiler: false });
    return { id: c.id, ms: performance.now() - t };
  },
  watch(work: string) {
    client().watchComments(work, (all) => comments.set(work, all));
    return true;
  },
  async waitComment(work: string, id: string, ms = 30_000) {
    const t = performance.now();
    while (performance.now() - t < ms) {
      if ((comments.get(work) ?? []).some((c) => c.id === id)) return performance.now() - t;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout waiting for comment ' + id);
  },
  devices: () => client().devices(),
  deviceKey: () => client().deviceKey(),
  logout: () => client().logout(),
  idbContains,
};

(window as unknown as { huwa: typeof api }).huwa = api;
document.title = 'huwa-e2e-ready';
