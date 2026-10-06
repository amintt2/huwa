// `bare` implementation of the P2P contract: a thin RPC client of the Bare worklet
// (src/p2p/worklet/, bundled into src/p2p/worklet.bundle.js by `npm run build:worklet`).
// The UI never touches cores: every method is one `bare-rpc` request {m, a} -> {ok, v | e}.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus } from 'react-native';

import { migrateLegacy, type LegacyState } from '@/social/migrate';

import type {
  CommentFlag,
  FlagReason,
  BackupState,
  Conversation,
  Device,
  DirectMessage,
  JournalEntry,
  Label,
  MappingProposal,
  MappingProposalInput,
  P2P,
  P2PComment,
  P2PStatus,
  CommunityStatsSums,
  Profile,
  PublicKey,
  RestoreOptions,
  StatsContribution,
  Unsubscribe,
} from './contract';
import { P2PError } from './errors';

const CMD = { CALL: 1, EVENT: 2 } as const;
const DEFAULT_TIMEOUT = 30_000;
/** PoW, pairing and restore can legitimately take long. */
const TIMEOUTS: Record<string, number> = {
  hello: 8_000,
  status: 4_000,
  restoreIdentity: 60_000,
  acceptPairing: 130_000,
  postComment: 60_000,
  proposeMapping: 60_000,
  flagComment: 60_000,
  sendMessage: 60_000,
  getProfile: 20_000,
  contributeStats: 90_000,
  communityStats: 30_000,
};
const MAX_RESTARTS = 5;
const LEGACY_KEY = 'huwa/state/v1';
const MIGRATED_KEY = 'huwa/p2p/bare/migrated';

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
  /** Called once when the worklet answered its first request, or failed to. */
  onBoot?: (ok: boolean, info: { readyMs?: number; error?: string }) => void;
};

type Sub = { kind: string; arg?: string; cb: (data: never) => void };

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class BareP2P implements P2P {
  readonly ready: Promise<void>;
  private worklet: WorkletInstance | null = null;
  private rpc: RPCInstance | null = null;
  private current: P2PStatus = { state: 'starting', peers: 0 };
  private meValue: Profile | undefined;
  private statusCbs = new Set<(s: P2PStatus) => void>();
  private subs = new Map<number, Sub>();
  private nextSid = 1;
  private restarts = 0;
  private restarting: Promise<void> | null = null;
  private generation = 0;
  /** Set once the worklet crashed MAX_RESTARTS times in a row: P2P stays off until the next launch. */
  private deadReason: string | null = null;

  constructor(private config: BareConfig) {
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
      JSON.stringify({ bootstrap: this.config.bootstrap ?? [], deviceName: this.config.deviceName }),
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

  private lastReadyMs: number | undefined;

  private async handshake() {
    const hello = await this.call<{ status: P2PStatus; me: Profile | null; readyMs: number }>('hello', []);
    // Older worklets answered `hello` even after a failed start: not a successful boot.
    if (hello.status?.state === 'error') throw new Error(hello.status.error ?? 'Démarrage P2P échoué');
    this.lastReadyMs = hello.readyMs;
    this.meValue = hello.me ?? undefined;
    this.setStatus(hello.status);
    // Re-subscribe watchers after a restart.
    for (const [sid, sub] of this.subs) {
      this.call('watch', [sid, sub.kind, sub.arg]).catch(() => {});
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
    let msg: { ev: string; sid?: number; data?: unknown };
    try {
      msg = JSON.parse(decoder.decode(req.data));
    } catch {
      return;
    }
    if (msg.ev === 'status') this.setStatus(msg.data as P2PStatus);
    else if (msg.ev === 'me') {
      this.meValue = (msg.data as Profile | null) ?? undefined;
      // `useMe()` re-reads `me()` on status notifications.
      this.setStatus(this.current);
    }
    else if (msg.ev === 'sub' && typeof msg.sid === 'number') this.subs.get(msg.sid)?.cb(msg.data as never);
  }

  private setStatus(s: P2PStatus) {
    this.current = s;
    for (const cb of this.statusCbs) cb(s);
  }

  private async call<T>(m: string, a: unknown[]): Promise<T> {
    if (this.restarting && m !== 'hello') await this.restarting;
    const rpc = this.rpc;
    if (!rpc) throw new Error(this.deadReason ? `P2P arrêté après plusieurs plantages (${this.deadReason}) : relance l’app.` : 'Worklet P2P indisponible');
    const req = rpc.request(CMD.CALL);
    req.send(JSON.stringify({ m, a }));
    const timeout = TIMEOUTS[m] ?? DEFAULT_TIMEOUT;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raw = await Promise.race([
      req.reply(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`P2P: délai dépassé (${m})`)), timeout);
      }),
    ]).finally(() => clearTimeout(timer));
    const res = JSON.parse(decoder.decode(raw)) as { ok: boolean; v?: T; e?: string; code?: string };
    if (!res.ok) throw new P2PError(res.e ?? 'Erreur P2P', res.code);
    return res.v as T;
  }

  private watch<T>(kind: string, arg: string | undefined, cb: (data: T) => void): Unsubscribe {
    const sid = this.nextSid++;
    this.subs.set(sid, { kind, arg, cb: cb as (data: never) => void });
    this.call('watch', [sid, kind, arg]).catch(() => {});
    return () => {
      if (!this.subs.delete(sid)) return;
      this.call('unwatch', [sid]).catch(() => {});
    };
  }

  /** Import the pre-P2P local history (finished episodes/chapters, comments) into the journal once. */
  private async migrate(profile: Profile) {
    if (await AsyncStorage.getItem(MIGRATED_KEY)) return;
    const raw = await AsyncStorage.getItem(LEGACY_KEY);
    if (raw) {
      const m = migrateLegacy(JSON.parse(raw) as LegacyState, { key: profile.key, name: profile.name });
      // Legacy comments stay on this device: republishing them would hit the rooms' rate limit
      // with backdated timestamps. Their activity still counts through the journal.
      for (const e of m.journal) await this.appendJournal(e).catch(() => {});
    }
    await AsyncStorage.setItem(MIGRATED_KEY, String(Date.now()));
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
  identityLog() {
    return this.call<{ t: string; body: unknown; ts: number; dev: string }[]>('identityLog', []);
  }
  vouch(seriesId: string, key: PublicKey) {
    return this.call<void>('vouch', [seriesId, key]);
  }

  // ---- P2P contract ------------------------------------------------------------

  status() {
    return this.current;
  }
  onStatus(cb: (s: P2PStatus) => void): Unsubscribe {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }

  me() {
    return this.meValue;
  }
  async createIdentity(name: string) {
    const r = await this.call<{ profile: Profile; phrase: string[] }>('createIdentity', [name]);
    this.meValue = r.profile;
    this.migrate(r.profile).catch((err) => console.warn('[huwa] migration', err));
    return r;
  }
  async restoreIdentity(phrase: string[], opts?: RestoreOptions) {
    this.meValue = await this.call<Profile>('restoreIdentity', opts ? [phrase, opts] : [phrase]);
    return this.meValue;
  }
  async updateProfile(patch: Partial<Pick<Profile, 'name' | 'bio' | 'avatar'>>) {
    this.meValue = await this.call<Profile>('updateProfile', [patch]);
    return this.meValue;
  }
  async getProfile(key: PublicKey) {
    return (await this.call<Profile | null>('getProfile', [key])) ?? undefined;
  }
  backupState() {
    return this.call<BackupState>('backupState', []);
  }
  markPhraseVerified() {
    return this.call<void>('markPhraseVerified', []);
  }
  devices() {
    return this.call<Device[]>('devices', []);
  }
  pairingInvite() {
    return this.call<string>('pairingInvite', []);
  }
  async acceptPairing(invite: string) {
    this.meValue = await this.call<Profile>('acceptPairing', [invite]);
    return this.meValue;
  }
  revokeDevice(deviceKey: string) {
    return this.call<void>('revokeDevice', [deviceKey]);
  }

  watchComments(seriesId: string, cb: (all: P2PComment[]) => void) {
    return this.watch('comments', seriesId, cb);
  }
  postComment(c: Pick<P2PComment, 'target' | 'parentId' | 'text' | 'spoiler' | 'timestamp'>) {
    return this.call<P2PComment>('postComment', [c]);
  }
  toggleLike(seriesId: string, commentId: string) {
    return this.call<void>('toggleLike', [seriesId, commentId]);
  }
  editComment(seriesId: string, commentId: string, patch: { text: string; spoiler: boolean }) {
    return this.call<void>('editComment', [seriesId, commentId, patch]);
  }
  deleteComment(seriesId: string, commentId: string) {
    return this.call<void>('deleteComment', [seriesId, commentId]);
  }
  watchFlags(seriesId: string, cb: (all: CommentFlag[]) => void) {
    return this.watch('flags', seriesId, cb);
  }
  async flagComment(seriesId: string, commentId: string, reason: FlagReason | null) {
    await this.call<void>('flagComment', [seriesId, commentId, reason]);
  }

  follow(key: PublicKey) {
    return this.call<void>('follow', [key]);
  }
  unfollow(key: PublicKey) {
    return this.call<void>('unfollow', [key]);
  }
  block(key: PublicKey) {
    return this.call<void>('block', [key]);
  }
  unblock(key: PublicKey) {
    return this.call<void>('unblock', [key]);
  }
  report(target: string, val: Label['val']) {
    return this.call<void>('report', [target, val]);
  }
  watchLabels(cb: (labels: Label[]) => void) {
    return this.watch('labels', undefined, cb);
  }
  subscribeLabeler(key: PublicKey) {
    return this.call<void>('subscribeLabeler', [key]);
  }

  watchConversations(cb: (c: Conversation[]) => void) {
    return this.watch('conversations', undefined, cb);
  }
  watchMessages(peer: PublicKey, cb: (m: DirectMessage[]) => void) {
    return this.watch('messages', peer, cb);
  }
  sendMessage(peer: PublicKey, text: string) {
    return this.call<DirectMessage>('sendMessage', [peer, text]);
  }
  markRead(peer: PublicKey) {
    return this.call<void>('markRead', [peer]);
  }

  appendJournal(e: JournalEntry) {
    return this.call<void>('appendJournal', [e]);
  }
  journal(key?: PublicKey) {
    return this.call<JournalEntry[]>('journal', [key ?? null]);
  }

  watchMapping(room: string, cb: (all: MappingProposal[]) => void) {
    return this.watch('mapping', room, cb);
  }
  async proposeMapping(p: MappingProposalInput) {
    await this.call<void>('proposeMapping', [p]);
  }

  async contributeStats(c: StatsContribution) {
    await this.call<boolean>('contributeStats', [c]);
  }
  communityStats() {
    return this.call<CommunityStatsSums>('communityStats', []);
  }
}

/** Throws synchronously when the native module is missing (web, Expo Go, old binary). */
export function createBareP2P(config: BareConfig): BareP2P {
  return new BareP2P(config);
}

export const _internal = { encoder };
