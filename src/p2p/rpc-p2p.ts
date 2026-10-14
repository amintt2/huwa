// Transport-agnostic client of a HuwaNode RPC server (src/p2p/worklet/dispatch.js): every P2P
// method is one request {m, a} -> {ok, v | e, code?}, and the node pushes {ev, sid?, data} events.
// BareP2P (src/p2p/bare.ts) speaks it over bare-rpc to the mobile worklet, WebP2P
// (src/p2p/web/client.ts) over MessagePorts to the browser node. Subclasses provide `send()` and
// call `onEvent()` / `handshake()`; everything else (timeouts, errors, watches, the contract) is here.
import AsyncStorage from '@react-native-async-storage/async-storage';

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

export const DEFAULT_TIMEOUT = 30_000;
/** PoW, pairing and restore can legitimately take long. */
export const TIMEOUTS: Record<string, number> = {
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
const LEGACY_KEY = 'huwa/state/v1';
const MIGRATED_KEY = 'huwa/p2p/bare/migrated';

/** Wire reply of the node. */
export type RpcReply = { ok: boolean; v?: unknown; e?: string; code?: string };
/** Wire event of the node. */
export type RpcEvent = { ev: string; sid?: number; data?: unknown };

type Sub = { kind: string; arg?: string; cb: (data: never) => void };

export abstract class RpcP2P implements P2P {
  protected current: P2PStatus = { state: 'starting', peers: 0 };
  protected meValue: Profile | undefined;
  private statusCbs = new Set<(s: P2PStatus) => void>();
  protected subs = new Map<number, Sub>();
  private nextSid = 1;
  protected lastReadyMs: number | undefined;

  /** Sends one request and resolves with the node's reply (the timeout is handled here). */
  protected abstract send(m: string, a: unknown[]): Promise<RpcReply>;

  /** Awaited before every call except `hello` (BareP2P waits for a worklet restart). */
  protected beforeCall(_m: string): Promise<void> | void {}

  protected timeoutOf(m: string) {
    return TIMEOUTS[m] ?? DEFAULT_TIMEOUT;
  }

  protected async handshake() {
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

  protected onEvent(msg: RpcEvent) {
    if (msg.ev === 'status') this.setStatus(msg.data as P2PStatus);
    else if (msg.ev === 'me') {
      this.meValue = (msg.data as Profile | null) ?? undefined;
      // `useMe()` re-reads `me()` on status notifications.
      this.setStatus(this.current);
    } else if (msg.ev === 'sub' && typeof msg.sid === 'number') this.subs.get(msg.sid)?.cb(msg.data as never);
  }

  protected setStatus(s: P2PStatus) {
    this.current = s;
    for (const cb of this.statusCbs) cb(s);
  }

  protected async call<T>(m: string, a: unknown[]): Promise<T> {
    if (m !== 'hello') await this.beforeCall(m);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const res = await Promise.race([
      this.send(m, a),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`P2P: délai dépassé (${m})`)), this.timeoutOf(m));
      }),
    ]).finally(() => clearTimeout(timer));
    if (!res.ok) throw new P2PError(res.e ?? 'Erreur P2P', res.code);
    return res.v as T;
  }

  protected watch<T>(kind: string, arg: string | undefined, cb: (data: T) => void): Unsubscribe {
    const sid = this.nextSid++;
    this.subs.set(sid, { kind, arg, cb: cb as (data: never) => void });
    this.call('watch', [sid, kind, arg]).catch(() => {});
    return () => {
      if (!this.subs.delete(sid)) return;
      this.call('unwatch', [sid]).catch(() => {});
    };
  }

  /** Import the pre-P2P local history (finished episodes/chapters, comments) into the journal once. */
  protected async migrate(profile: Profile) {
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
