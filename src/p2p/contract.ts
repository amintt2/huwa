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
};

export type Label = { by: PublicKey; target: PublicKey | string; val: 'spam' | 'abuse' | 'spoiler' | 'nsfw' | 'hide'; neg?: boolean; ts: number };

export type Conversation = { peer: PublicKey; peerName: string; lastText: string; lastAt: number; unread: number; request: boolean };
export type DirectMessage = { id: string; from: PublicKey; to: PublicKey; text: string; createdAt: number; delivered: boolean };

export type JournalEntry =
  | { type: 'ep'; work: string; unit: number; ts: number }
  | { type: 'ch'; work: string; unit: number; ts: number }
  | { type: 'comment'; work: string; ts: number };

export type Unsubscribe = () => void;

export interface P2P {
  status(): P2PStatus;
  onStatus(cb: (s: P2PStatus) => void): Unsubscribe;

  // Identity (phase 2)
  me(): Profile | undefined;
  createIdentity(name: string): Promise<{ profile: Profile; phrase: string[] }>;
  restoreIdentity(phrase: string[]): Promise<Profile>;
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
}
