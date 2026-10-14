// `web` implementation of the P2P contract: the RpcP2P client (../rpc-p2p.ts, same {m, a}
// protocol as the mobile worklet) of the browser node (./worker.ts) shared by every tab.
//
// The node is not started for a logged-out visitor: the worker is only contacted when this browser
// holds an account (hint in localStorage, or a "public computer" session alive in another tab) or
// when a login flow starts (`session.begin`). Until then the backend answers like an empty local
// profile. Session control for the login screens (src/components/web-login/) is `webSession()`.
import { RpcP2P, type RpcEvent, type RpcReply } from '../rpc-p2p';
import type { P2PStatus } from '../contract';
import { P2PError } from '../errors';

import { openNodeChannel, supportsBrowserNode, type NodeChannel, type NodeMessage } from './channel';

export type WebStorageMode = 'device' | 'passkey' | 'memory';

/** What the worker reports about this browser's account session (src/p2p/web/session.js). */
export type WebSessionInfo = {
  state: 'idle' | 'locked' | 'ready' | 'error';
  mode: WebStorageMode | null;
  hasAccount: boolean;
  me: { key: string; name: string; fingerprint: string } | null;
  gateway: string;
  deviceName: string;
  passkey: { credentialId: string; prfSalt: string } | null;
  online: boolean;
  error: { code: string; message: string } | null;
  storageError: { code: string; message: string } | null;
};

export type WebP2PConfig = {
  /** Worker script (default /p2p-worker.js, built by `npm run build:p2p-worker`). */
  workerUrl?: string;
  /** Gateway WebSocket (default: this origin's /p2p). */
  gateway?: string;
  onBoot?: (ok: boolean, info: { readyMs?: number; error?: string }) => void;
};

const HINT = 'huwa/web/account';
/** Methods that may start the worker (login flows); others fail fast while no node runs. */
const STARTS_WORKER = /^session\.|^(createIdentity|restoreIdentity|acceptPairing)$/;
const IDLE: WebSessionInfo = { state: 'idle', mode: null, hasAccount: false, me: null, gateway: '', deviceName: '', passkey: null, online: false, error: null, storageError: null };

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

/** Does this browser (probably) hold an account the node should be started for? */
async function accountHint(): Promise<boolean> {
  if (storage('local')?.getItem(HINT) || storage('session')?.getItem(HINT)) return true;
  try {
    const state = await navigator.locks?.query();
    return !!state?.held?.some((l) => l.name === 'huwa-p2p-active');
  } catch {
    return false;
  }
}

function setHint(mode: WebStorageMode | null) {
  storage('local')?.removeItem(HINT);
  storage('session')?.removeItem(HINT);
  if (mode === 'memory') storage('session')?.setItem(HINT, mode);
  else if (mode) storage('local')?.setItem(HINT, mode);
}

export function defaultGateway(): string {
  const override = (globalThis as { __HUWA_GATEWAY__?: string }).__HUWA_GATEWAY__ ?? process.env.EXPO_PUBLIC_HUWA_GATEWAY;
  if (override) return override;
  return typeof location !== 'undefined' ? location.origin.replace(/^http/, 'ws') + '/p2p' : '';
}

export class WebP2P extends RpcP2P {
  readonly ready: Promise<void>;
  private channel: NodeChannel | null = null;
  private connecting: Promise<void> | null = null;
  private pending = new Map<number, (r: RpcReply) => void>();
  private nextId = 1;
  private sessionValue: WebSessionInfo = IDLE;
  private sessionCbs = new Set<(s: WebSessionInfo) => void>();

  constructor(private config: WebP2PConfig = {}) {
    super();
    this.ready = this.boot();
  }

  private async boot() {
    if (!supportsBrowserNode()) throw new Error('Ce navigateur ne peut pas faire tourner le nœud Huwa');
    if (await accountHint()) {
      try {
        await this.connect();
        this.config.onBoot?.(true, { readyMs: this.lastReadyMs });
        return;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.config.onBoot?.(false, { error });
        this.setStatus({ state: 'error', peers: 0, error });
        throw err;
      }
    }
    this.setStatus({ state: 'ready', peers: 0 });
  }

  private workerUrl() {
    const base = this.config.workerUrl ?? '/p2p-worker.js';
    const gw = this.config.gateway ?? defaultGateway();
    return base + (base.includes('?') ? '&' : '?') + 'gw=' + encodeURIComponent(gw);
  }

  /** Starts (or joins) the node worker. */
  connect(): Promise<void> {
    if (!this.connecting) {
      this.connecting = (async () => {
        const ch = await openNodeChannel(this.workerUrl());
        ch.onmessage = (msg) => this.onNodeMessage(msg);
        ch.onreset = () => this.onReset();
        this.channel = ch;
        if (typeof addEventListener === 'function') addEventListener('pagehide', () => ch.close(), { once: true });
        await this.handshake();
      })();
      this.connecting.catch(() => {
        this.connecting = null;
        this.channel?.close();
        this.channel = null;
      });
    }
    return this.connecting;
  }

  private onReset() {
    for (const resolve of this.pending.values()) resolve({ ok: false, e: 'Le nœud P2P a changé d’onglet, réessaie.', code: 'NODE_MOVED' });
    this.pending.clear();
    this.handshake().catch(() => {});
  }

  private onNodeMessage(msg: NodeMessage) {
    if (msg.t === 'reply') {
      const resolve = this.pending.get(msg.id as number);
      if (resolve) {
        this.pending.delete(msg.id as number);
        resolve(msg as unknown as RpcReply);
      }
      return;
    }
    if (msg.t !== 'event') return;
    const ev = msg as unknown as RpcEvent;
    if (ev.ev === 'session') return this.setSession(ev.data as WebSessionInfo);
    this.onEvent(ev);
  }

  private setSession(s: WebSessionInfo) {
    this.sessionValue = s;
    if (s.me || s.state === 'locked') setHint(s.mode);
    for (const cb of this.sessionCbs) cb(s);
    if (s.state === 'idle') {
      this.meValue = undefined;
      this.setStatus({ state: 'ready', peers: 0 });
    } else if (s.state === 'locked') {
      this.meValue = undefined;
      this.setStatus({ state: 'offline', peers: 0 });
    }
  }

  protected override async handshake() {
    await super.handshake();
    // `hello` of the web host also carries the session.
    const info = await this.call<WebSessionInfo>('session.info', []);
    this.setSession(info);
  }

  protected override async beforeCall(m: string) {
    if (this.channel || this.connecting) {
      if (this.connecting && m !== 'session.info') await this.connecting.catch(() => {});
      return;
    }
    if (STARTS_WORKER.test(m)) await this.connect();
  }

  protected send(m: string, a: unknown[]): Promise<RpcReply> {
    const ch = this.channel;
    if (!ch) return Promise.resolve({ ok: false, e: 'Aucune session P2P dans ce navigateur', code: 'NO_SESSION' });
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      ch.post({ t: 'call', id, m, a });
    });
  }

  protected override timeoutOf(m: string) {
    if (m === 'session.logout') return 30_000;
    if (m.startsWith('session.')) return 60_000;
    return super.timeoutOf(m);
  }

  // ---- session (login screens) ------------------------------------------------

  session(): WebSessionInfo {
    return this.sessionValue;
  }

  onSession(cb: (s: WebSessionInfo) => void) {
    this.sessionCbs.add(cb);
    return () => {
      this.sessionCbs.delete(cb);
    };
  }

  /** Starts a node for a login flow. `memory` = "public computer": nothing is written to disk. */
  async begin(opts: { mode: 'device' | 'memory' }) {
    const info = await this.call<WebSessionInfo>('session.begin', [opts]);
    this.setSession(info);
    await this.handshake();
    return info;
  }

  /** Abandons a login flow that did not produce an identity (wipes what it stored). */
  async cancel() {
    if (!this.channel) return this.sessionValue;
    const info = await this.call<WebSessionInfo>('session.cancel', []);
    this.setSession(info);
    return info;
  }

  async unlock(kek: CryptoKey) {
    const info = await this.call<WebSessionInfo>('session.unlock', [kek]);
    this.setSession(info);
    await this.handshake();
    return info;
  }

  async lock() {
    const info = await this.call<WebSessionInfo>('session.lock', []);
    this.setSession(info);
    return info;
  }

  async enablePasskey(kek: CryptoKey, meta: { credentialId: string; prfSalt: string }) {
    const info = await this.call<WebSessionInfo>('session.enablePasskey', [kek, meta]);
    this.setSession(info);
    return info;
  }

  async disablePasskey(kek: CryptoKey) {
    const info = await this.call<WebSessionInfo>('session.disablePasskey', [kek]);
    this.setSession(info);
    return info;
  }

  /** Signed remove-device of this browser, then every local byte is wiped. */
  async logout(): Promise<{ revoked: boolean; replicated: boolean }> {
    if (!this.channel) await this.connect();
    const r = await this.call<{ revoked: boolean; replicated: boolean; info: WebSessionInfo }>('session.logout', [{}]);
    setHint(null);
    this.setSession(r.info);
    return { revoked: r.revoked, replicated: r.replicated };
  }

  /** This browser's device key in the account (to tell it apart in `devices()`). */
  deviceKey() {
    return this.call<string | null>('session.deviceKey', []);
  }

  status(): P2PStatus {
    return super.status();
  }
}

export function createWebP2P(config?: WebP2PConfig) {
  return new WebP2P(config);
}

export const isNoSession = (e: unknown) => e instanceof P2PError && e.code === 'NO_SESSION';
