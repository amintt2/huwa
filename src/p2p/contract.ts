// Contract between the React Native UI and the P2P layer (Bare worklet, see PLAN.md).
// The UI only talks to `P2P`; two implementations exist:
//   - `local` (AsyncStorage, single device) so the app works before/without the worklet,
//   - `bare`  (Hypercore/Autobase over Hyperswarm) once the worklet is running.
// Every payload coming from a peer is untrusted: validate size, schema and signature before use.

/** z32/hex public key of the identity root (stable across devices and rotations). */
export type PublicKey = string;

export type P2PStatus = { state: 'starting' | 'ready' | 'offline' | 'error'; peers: number; error?: string };

export type Profile = {
  key: PublicKey;
  name: string;
  bio?: string;
  avatar?: string;
  createdAt: number;
  /** Short fingerprint shown next to the name to tell homonyms apart. */
  fingerprint: string;
};

export type Device = { key: string; name: string; addedAt: number; current: boolean; revoked?: boolean };

export type BackupState = { cloud: boolean; phraseVerified: boolean; devices: number };

/** Mirrors `Comment` in src/store/store.ts, plus the author's key. */
export type P2PComment = {
  id: string;
  /** `ep:<episodeId>`, `ch:<chapterId>` or `series:<seriesId>` */
  target: string;
  parentId?: string;
  author: PublicKey;
  authorName: string;
  text: string;
  createdAt: number;
  likes: number;
  likedByMe: boolean;
  spoiler: boolean;
  timestamp?: number;
  fromAnime?: boolean;
  /** Edited by its author (last edit time). */
  editedAt?: number;
  /** Deleted by its author: text is empty, kept only as a placeholder when it has replies. */
  deleted?: boolean;
};

/**
 * Community report of a comment, published in the work's flag room (separate base, signed by the
 * identity, PoW, rate limited). Every reader weighs them (src/social/community.ts); nothing is
 * deleted. One active flag per (author, comment): the newest replaces it, `null` retracts it.
 */
export type FlagReason = 'spoiler' | 'abuse' | 'nsfw' | 'spam' | 'other';
export type CommentFlag = { comment: string; author: PublicKey; reason: FlagReason; ts: number };

export type Label = { by: PublicKey; target: PublicKey | string; val: 'spam' | 'abuse' | 'spoiler' | 'nsfw' | 'hide'; neg?: boolean; ts: number };

export type Conversation = { peer: PublicKey; peerName: string; lastText: string; lastAt: number; unread: number; request: boolean };
export type DirectMessage = { id: string; from: PublicKey; to: PublicKey; text: string; createdAt: number; delivered: boolean };

export type JournalEntry =
  | { type: 'ep'; work: string; unit: number; ts: number }
  | { type: 'ch'; work: string; unit: number; ts: number }
  | { type: 'comment'; work: string; ts: number };

/**
 * Opt-in community playback stats (src/stats/community.ts): coarse noisy aggregates, no identity.
 * `h`: time-to-first-frame histogram per playback path, `s`: [played, failed, stalled].
 */
export type StatsContribution = { id: string; v: number; h: Partial<Record<string, number[]>>; s: [number, number, number] };
export type CommunityStatsSums = { contributions: number; h: Partial<Record<string, number[]>>; s: [number, number, number] };

/**
 * Community correction of the episode ↔ chapter mapping (src/data/mapping.ts), published in the
 * room of the manhwa (`room`: `m<AniList id>` or a series id) for one season (`season`: series id).
 * `end`: the season ends at chapter `to`; `ep`: episode `ep` adapts chapters `from`–`to`.
 * One active proposal per author and field: the newest replaces the older ones.
 */
export type MappingProposalInput =
  | { room: string; season: string; field: 'end'; to: number }
  | { room: string; season: string; field: 'ep'; ep: number; from: number; to: number };
export type MappingProposal = {
  season: string;
  field: 'end' | 'ep';
  ep?: number;
  from?: number;
  to: number;
  author: PublicKey;
  ts: number;
};

export type Unsubscribe = () => void;

/**
 * Restore from the recovery phrase. By default only joins the account's existing data and fails
 * with RESTORE_NOT_FOUND (src/p2p/errors.ts) when none of its devices answers. `allowNewHome` is
 * the explicit, user-confirmed fallback when every device is gone: same identity (key,
 * fingerprint), fresh profile named `name`, without the data that lived on the missing devices.
 */
export type RestoreOptions = { allowNewHome?: boolean; name?: string };

export interface P2P {
  status(): P2PStatus;
  onStatus(cb: (s: P2PStatus) => void): Unsubscribe;

  // Identity (phase 2)
  me(): Profile | undefined;
  createIdentity(name: string): Promise<{ profile: Profile; phrase: string[] }>;
  restoreIdentity(phrase: string[], opts?: RestoreOptions): Promise<Profile>;
  updateProfile(patch: Partial<Pick<Profile, 'name' | 'bio' | 'avatar'>>): Promise<Profile>;
  getProfile(key: PublicKey): Promise<Profile | undefined>;
  backupState(): Promise<BackupState>;
  markPhraseVerified(): Promise<void>;
  devices(): Promise<Device[]>;
  pairingInvite(): Promise<string>;
  acceptPairing(invite: string): Promise<Profile>;
  revokeDevice(deviceKey: string): Promise<void>;

  // Comments (phase 3) — one room per work (`seriesId`)
  watchComments(seriesId: string, cb: (all: P2PComment[]) => void): Unsubscribe;
  postComment(c: Pick<P2PComment, 'target' | 'parentId' | 'text' | 'spoiler' | 'timestamp'>): Promise<P2PComment>;
  toggleLike(seriesId: string, commentId: string): Promise<void>;
  /** Only the author can edit or delete; peers enforce it in the room reducer. */
  editComment(seriesId: string, commentId: string, patch: { text: string; spoiler: boolean }): Promise<void>;
  deleteComment(seriesId: string, commentId: string): Promise<void>;
  /** Community reports of a work's comments (see CommentFlag). */
  watchFlags(seriesId: string, cb: (all: CommentFlag[]) => void): Unsubscribe;
  flagComment(seriesId: string, commentId: string, reason: FlagReason | null): Promise<void>;

  // Moderation (phase 4)
  follow(key: PublicKey): Promise<void>;
  unfollow(key: PublicKey): Promise<void>;
  block(key: PublicKey): Promise<void>;
  unblock(key: PublicKey): Promise<void>;
  report(target: string, val: Label['val']): Promise<void>;
  /** Labels/blocks published by me and by the lists I subscribe to. */
  watchLabels(cb: (labels: Label[]) => void): Unsubscribe;
  subscribeLabeler(key: PublicKey): Promise<void>;

  // Direct messages (phase 5)
  watchConversations(cb: (c: Conversation[]) => void): Unsubscribe;
  watchMessages(peer: PublicKey, cb: (m: DirectMessage[]) => void): Unsubscribe;
  sendMessage(peer: PublicKey, text: string): Promise<DirectMessage>;
  markRead(peer: PublicKey): Promise<void>;

  // Journal → rank / history (phase 6)
  appendJournal(e: JournalEntry): Promise<void>;
  journal(key?: PublicKey): Promise<JournalEntry[]>;

  // Episode ↔ chapter corrections (one room per manhwa, signed by the identity, PoW, rate limited).
  watchMapping(room: string, cb: (all: MappingProposal[]) => void): Unsubscribe;
  proposeMapping(p: MappingProposalInput): Promise<void>;

  // Community playback stats (opt-in). Published in a public room by a throwaway writer on a
  // separate swarm: never signed with, nor sent alongside, the identity or device keys.
  contributeStats(c: StatsContribution): Promise<void>;
  /** Sums of the recent contributions, or null when the network is not available. */
  communityStats(): Promise<CommunityStatsSums | null>;
}
