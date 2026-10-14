// `bare` implementation of the P2P contract: a thin RPC client of the Bare worklet
// (src/p2p/worklet/, bundled into src/p2p/worklet.bundle.js by `npm run build:worklet`).
// The UI never touches cores: every method is one `bare-rpc` request {m, a} -> {ok, v | e}.
// Timeouts, errors, watches and the contract methods live in RpcP2P (./rpc-p2p.ts), shared with
// the browser node client (./web/client.ts); this file is the bare-rpc transport and the worklet
// lifecycle (start, restart with backoff, AppState check).
import { AppState, type AppStateStatus } from 'react-native';

import type { P2PStatus } from './contract';
import type { RelayConfig } from './relays';
import { RpcP2P, type RpcEvent, type RpcReply } from './rpc-p2p';

const CMD = { CALL: 1, EVENT: 2 } as const;
const MAX_RESTARTS = 5;

type Bytes = Uint8Array;
type IncomingMessage = { command: number; data: Bytes | null };
type OutgoingRequest = { send(data: string): void; reply(): Promise<Bytes> };
type RPCInstance = { request(command: number): OutgoingRequest };
type RPCConstructor = new (stream: unknown, onrequest: (req: IncomingMessage) => void) => RPCInstance;
type WorkletInstance = {
  IPC: { on(ev: 'error' | 'close', cb: (err?: Error) => void): void };
  start(filename: string, source: string, args: string[]): void;
  terminate(): void;
};
type WorkletConstructor = new (opts?: { memoryLimit?: number }) => WorkletInstance;

export type BareConfig = {
  /** Directory the worklet stores its Corestore in (no `file://`). */
  storage: string;
  /** Custom DHT bootstrap nodes, `host:port`. Empty = public Holepunch nodes. */
  bootstrap?: string[];
  deviceName?: string;
  /** Huwa relays (src/p2p/relays.ts); updated live with `setRelays`. */
  relays?: RelayConfig;
  /** Called once when the worklet answered its first request, or failed to. */
  onBoot?: (ok: boolean, info: { readyMs?: number; error?: string }) => void;
};

/** What the worklet reports about its relays (src/p2p/worklet/relay.js). */
export type RelayStatus = { enabled: boolean; relays: number; connected: number; cores: number; bases: number };

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class BareP2P extends RpcP2P {
  readonly ready: Promise<void>;
  private worklet: WorkletInstance | null = null;
  private rpc: RPCInstance | null = null;
  private restarts = 0;
  private restarting: Promise<void> | null = null;
  private generation = 0;
  /** Set once the worklet crashed MAX_RESTARTS times in a row: P2P stays off until the next launch. */
  private deadReason: string | null = null;

  constructor(private config: BareConfig) {
    super();
    this.ready = this.boot();
    AppState.addEventListener('change', (s) => this.onAppState(s));
  }

  // ---- worklet lifecycle ----------------------------------------------------

  private start() {
    // Lazy requires: the native module and the multi-MB bundle only load on the bare path.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { Worklet } = require('react-native-bare-kit') as { Worklet: WorkletConstructor };
    const RPC = require('bare-rpc') as RPCConstructor;
    const source = require('./worklet.bundle.js') as string;
    /* eslint-enable @typescript-eslint/no-require-imports */

    const generation = ++this.generation;
    const worklet = new Worklet({ memoryLimit: 0 });
    worklet.start('/huwa.bundle', source, [
      this.config.storage,
      JSON.stringify({ bootstrap: this.config.bootstrap ?? [], deviceName: this.config.deviceName, relays: this.config.relays ?? null }),
    ]);
    const onDead = (err?: Error) => {
      if (generation === this.generation) this.recover(err?.message ?? 'IPC fermé');
    };
    worklet.IPC.on('error', onDead);
    worklet.IPC.on('close', onDead);
    this.worklet = worklet;
    this.rpc = new RPC(worklet.IPC, (req) => this.onMessage(req));
  }

  private async boot() {
    try {
      this.start();
      await this.handshake();
      this.config.onBoot?.(true, { readyMs: this.lastReadyMs });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.setStatus({ state: 'error', peers: 0, error });
      this.config.onBoot?.(false, { error });
      throw err;
    }
  }

  private recover(reason: string) {
    if (this.restarting) return;
    this.setStatus({ state: 'error', peers: 0, error: reason });
    if (this.restarts >= MAX_RESTARTS) {
      // Given up: drop the dead worklet so every call fails at once instead of timing out.
      try {
        this.worklet?.terminate();
      } catch {
        // already gone
      }
      this.worklet = null;
      this.rpc = null;
      this.deadReason = reason;
      return;
    }
    const attempt = ++this.restarts;
    this.restarting = (async () => {
      try {
        this.worklet?.terminate();
      } catch {
        // already gone
      }
      this.worklet = null;
      this.rpc = null;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      try {
        this.start();
        await this.handshake();
        this.restarts = 0;
      } catch (err) {
        this.restarting = null;
        this.recover(err instanceof Error ? err.message : String(err));
        return;
      }
      this.restarting = null;
    })();
  }

  /**
   * react-native-bare-kit already suspends the worklet on `background` and resumes it on `active`
   * (its own AppState listener). Here we only check the worklet is still alive when coming back,
   * and restart it otherwise.
   */
  private onAppState(state: AppStateStatus) {
    if (state !== 'active' || !this.rpc) return;
    this.call<P2PStatus>('status', [])
      .then((s) => this.setStatus(s))
      .catch((err) => this.recover(err instanceof Error ? err.message : String(err)));
  }

  private onMessage(req: IncomingMessage) {
    if (req.command !== CMD.EVENT || !req.data) return;
    let msg: RpcEvent;
    try {
      msg = JSON.parse(decoder.decode(req.data));
    } catch {
      return;
    }
    this.onEvent(msg);
  }

  protected beforeCall() {
    return this.restarting ?? undefined;
  }

  protected async send(m: string, a: unknown[]): Promise<RpcReply> {
    const rpc = this.rpc;
    if (!rpc) throw new Error(this.deadReason ? `P2P arrêté après plusieurs plantages (${this.deadReason}) : relance l’app.` : 'Worklet P2P indisponible');
    const req = rpc.request(CMD.CALL);
    req.send(JSON.stringify({ m, a }));
    return JSON.parse(decoder.decode(await req.reply())) as RpcReply;
  }

  // ---- diagnostics (spike) ---------------------------------------------------

  /** Hyperbee put/get round-trip inside the worklet. */
  selftest() {
    return this.call<{ ok: boolean; put: number; get: unknown }>('selftest', []);
  }
  /** Throws inside the worklet on purpose; the app must survive. */
  crashTest() {
    return this.call<string>('crash', []);
  }

  // ---- Huwa relays (not part of the contract: the local backend has no network) -------

  /** Also kept for the next worklet (re)start. */
  async setRelays(relays: RelayConfig) {
    this.config = { ...this.config, relays };
    if (this.rpc) await this.call<RelayStatus>('setRelays', [relays]);
  }
  relayStatus() {
    return this.call<RelayStatus>('relayStatus', []);
  }
}

/** Throws synchronously when the native module is missing (web, Expo Go, old binary). */
export function createBareP2P(config: BareConfig): BareP2P {
  return new BareP2P(config);
}

export const _internal = { encoder };
