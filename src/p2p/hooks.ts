// React bindings for the P2P contract + the UI-side actions (which also keep prefs and the
// activity journal in sync). Screens use these, never `getP2P()` directly.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { badges as computeBadges } from '@/social/badges';
import { moderate, myBlocks, type ModerationContext, type Verdict } from '@/social/moderation';
import { seriesOfTarget } from '@/social/migrate';
import { commentPowPayload, powDifficulty, warmPow } from '@/social/pow';
import { replayJournal } from '@/social/rank';

import type { BackupState, Conversation, Device, DirectMessage, JournalEntry, Label, P2PComment, P2PStatus, Profile, PublicKey } from './contract';
import { DEMO_LABELERS } from './demo';
import { getP2P } from './index';
import { recoveryPhrase } from './phrase';
import { getPrefs, setPrefs, toggleIn, usePrefs } from './prefs';

const p2p = () => getP2P();

// ---------- tiny event bus for things the contract does not push ----------

function bus() {
  const ls = new Set<() => void>();
  let version = 0;
  return {
    emit() {
      version++;
      ls.forEach((l) => l());
    },
    subscribe(l: () => void) {
      ls.add(l);
      return () => {
        ls.delete(l);
      };
    },
    version: () => version,
  };
}
const identityBus = bus();
const journalBus = bus();
const securityBus = bus();

// ---------- status & identity ----------

let lastStatus: P2PStatus | undefined;
function statusSnapshot(): P2PStatus {
  const s = p2p().status();
  if (lastStatus && lastStatus.state === s.state && lastStatus.peers === s.peers && lastStatus.error === s.error) return lastStatus;
  lastStatus = s;
  return s;
}

export function useP2PStatus(): P2PStatus {
  return useSyncExternalStore((l) => p2p().onStatus(l), statusSnapshot, statusSnapshot);
}

let lastMe: Profile | undefined;
function meSnapshot(): Profile | undefined {
  const m = p2p().me();
  if (!m) return (lastMe = undefined);
  if (lastMe && lastMe.key === m.key && lastMe.name === m.name && lastMe.bio === m.bio && lastMe.avatar === m.avatar) return lastMe;
  lastMe = m;
  return m;
}
const subscribeMe = (l: () => void) => {
  const a = p2p().onStatus(l);
  const b = identityBus.subscribe(l);
  return () => {
    a();
    b();
  };
};

export function useMe(): Profile | undefined {
  return useSyncExternalStore(subscribeMe, meSnapshot, meSnapshot);
}

/** Profile of any key (me, a followed peer, a comment author). */
export function useProfile(key: PublicKey | undefined) {
  const me = useMe();
  const [result, setResult] = useState<{ key: string; profile?: Profile }>();
  useEffect(() => {
    let alive = true;
    if (!key) return;
    p2p()
      .getProfile(key)
      .then((profile) => alive && setResult({ key, profile }))
      .catch(() => alive && setResult({ key }));
    return () => {
      alive = false;
    };
  }, [key, me]);
  const fresh = result?.key === key;
  return { profile: fresh ? result?.profile : undefined, loading: !!key && !fresh };
}

/** Display name: my nickname for this key first (petname), then their chosen pseudo. */
export function usePetname(key: string | undefined, fallback: string) {
  const pet = usePrefs((p) => (key ? p.petnames[key] : undefined));
  return pet || fallback;
}

// ---------- comments ----------

export type CommentView = P2PComment & { verdict: Verdict };

export function useModeration(): ModerationContext {
  const me = useMe();
  const labels = useLabels();
  const subscriptions = usePrefs((p) => p.subscriptions);
  const words = usePrefs((p) => p.words);
  return useMemo(() => ({ me: me?.key, labels, subscriptions, words, threshold: 2 }), [me?.key, labels, subscriptions, words]);
}

/** Every comment of a work (one room per `seriesId`). */
export function useRoom(seriesId: string) {
  const [all, setAll] = useState<P2PComment[]>([]);
  useEffect(() => p2p().watchComments(seriesId, setAll), [seriesId]);
  return all;
}

/** Thread of one target with the local moderation verdict of each comment. */
export function useComments(seriesId: string, target: string) {
  const all = useRoom(seriesId);
  const ctx = useModeration();
  return useMemo(() => {
    const list = all.filter((c) => c.target === target);
    const verdicts = moderate(list, ctx);
    const items: CommentView[] = list.map((c) => ({ ...c, verdict: verdicts.get(c.id) ?? { hidden: false, spoiler: c.spoiler } }));
    const visible = items.filter((c) => !c.verdict.hidden);
    return { items, visible, hiddenCount: items.length - visible.length };
  }, [all, ctx, target]);
}

// ---------- labels ----------

export function useLabels(): Label[] {
  const [labels, setLabels] = useState<Label[]>(EMPTY);
  useEffect(() => p2p().watchLabels(setLabels), []);
  return labels;
}
const EMPTY: Label[] = [];

// ---------- direct messages ----------

export function useConversations() {
  const [list, setList] = useState<Conversation[]>([]);
  useEffect(() => p2p().watchConversations(setList), []);
  const ctx = useModeration();
  const acceptRequests = usePrefs((p) => p.dmRequests);
  return useMemo(() => {
    const verdicts = moderate(
      list.map((c) => ({ id: c.peer, author: c.peer, text: c.lastText })),
      { ...ctx, words: [] },
    );
    const visible = list.filter((c) => !verdicts.get(c.peer)?.hidden);
    const conversations = visible.filter((c) => !c.request);
    const requests = acceptRequests ? visible.filter((c) => c.request) : [];
    const unread = conversations.reduce((n, c) => n + c.unread, 0);
    return { conversations, requests, unread, requestCount: requests.length };
  }, [list, ctx, acceptRequests]);
}

export function useMessages(peer: PublicKey) {
  const [list, setList] = useState<DirectMessage[]>([]);
  useEffect(() => p2p().watchMessages(peer, setList), [peer]);
  return list;
}

// ---------- rank / journal ----------

export function useJournal(key?: PublicKey) {
  const version = useSyncExternalStore(journalBus.subscribe, journalBus.version, journalBus.version);
  const me = useMe();
  const [state, setState] = useState<{ key?: string; journal: JournalEntry[]; loadedAt: number }>();
  useEffect(() => {
    let alive = true;
    p2p()
      .journal(key)
      .then((journal) => alive && setState({ key, journal, loadedAt: Date.now() }))
      .catch(() => alive && setState({ key, journal: [], loadedAt: Date.now() }));
    return () => {
      alive = false;
    };
  }, [key, version, me?.key]);
  return state?.key === key ? state : undefined;
}

/** Rank recomputed *here* from the author's journal (never trusted from the author). */
export function useRank(key?: PublicKey) {
  const loaded = useJournal(key);
  return useMemo(() => {
    if (!loaded) return { loading: true as const };
    const { journal, loadedAt } = loaded;
    // `now` only rejects entries dated in the future (clock of the viewer, not the author).
    const rank = replayJournal(journal, undefined, loadedAt);
    return { loading: false as const, journal, rank, badges: computeBadges(journal), loadedAt };
  }, [loaded]);
}

// ---------- security ----------

export function useSecurity() {
  const version = useSyncExternalStore(securityBus.subscribe, securityBus.version, securityBus.version);
  const [state, setState] = useState<BackupState | undefined>();
  const [devices, setDevices] = useState<Device[]>([]);
  useEffect(() => {
    let alive = true;
    Promise.all([p2p().backupState(), p2p().devices()])
      .then(([b, d]) => {
        if (!alive) return;
        setState(b);
        setDevices(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [version]);
  return { state, devices, refresh: securityBus.emit };
}

// ---------- actions ----------

/** Subscribe once to the default block lists so the "2 lists" rule has something to stack. */
function applyDefaults() {
  if (getPrefs().defaultsApplied) return;
  const keys = DEMO_LABELERS.map((l) => l.key);
  setPrefs((p) => ({ ...p, subscriptions: [...new Set([...p.subscriptions, ...keys])], knownLabelers: [...new Set([...p.knownLabelers, ...keys])], defaultsApplied: true }));
  keys.forEach((k) => p2p().subscribeLabeler(k).catch(() => {}));
}

export const social = {
  async createIdentity(name: string) {
    const r = await p2p().createIdentity(name);
    await recoveryPhrase.set(r.phrase).catch(() => {});
    applyDefaults();
    identityBus.emit();
    journalBus.emit();
    return r;
  },
  async restoreIdentity(words: string[]) {
    const r = await p2p().restoreIdentity(words);
    await recoveryPhrase.set(words).catch(() => {});
    applyDefaults();
    identityBus.emit();
    journalBus.emit();
    securityBus.emit();
    return r;
  },
  async acceptPairing(invite: string) {
    const r = await p2p().acceptPairing(invite);
    applyDefaults();
    identityBus.emit();
    securityBus.emit();
    return r;
  },
  async updateProfile(patch: Partial<Pick<Profile, 'name' | 'bio' | 'avatar'>>) {
    const r = await p2p().updateProfile(patch);
    identityBus.emit();
    return r;
  },
  async markPhraseVerified() {
    await p2p().markPhraseVerified();
    securityBus.emit();
  },
  async revokeDevice(key: string) {
    await p2p().revokeDevice(key);
    securityBus.emit();
  },
  pairingInvite: () => p2p().pairingInvite(),

  async postComment(c: Pick<P2PComment, 'target' | 'parentId' | 'text' | 'spoiler' | 'timestamp'>) {
    const posted = await p2p().postComment(c);
    // The journal feeds rank/badges. The P2P layer does not append comments itself.
    await p2p().appendJournal({ type: 'comment', work: seriesOfTarget(c.target), ts: posted.createdAt }).catch(() => {});
    journalBus.emit();
    return posted;
  },
  toggleLike: (seriesId: string, id: string) => p2p().toggleLike(seriesId, id),

  async setFollow(key: string, on: boolean) {
    setPrefs((p) => ({ ...p, follows: toggleIn(p.follows, key, on) }));
    await (on ? p2p().follow(key) : p2p().unfollow(key));
  },
  async setBlocked(key: string, on: boolean) {
    if (on) setPrefs((p) => ({ ...p, follows: toggleIn(p.follows, key, false) }));
    await (on ? p2p().block(key) : p2p().unblock(key));
  },
  report: (target: string, val: Label['val']) => p2p().report(target, val),
  async setSubscribed(key: string, on: boolean) {
    setPrefs((p) => ({ ...p, subscriptions: toggleIn(p.subscriptions, key, on), knownLabelers: toggleIn(p.knownLabelers, key, true) }));
    // No "unsubscribe" in the contract: labels keep flowing but the local filter ignores them.
    if (on) await p2p().subscribeLabeler(key);
  },

  sendMessage: (peer: string, text: string) => p2p().sendMessage(peer, text),
  markRead: (peer: string) => p2p().markRead(peer),

  async appendJournal(e: JournalEntry) {
    await p2p().appendJournal(e);
    journalBus.emit();
  },
};

/** Keys I block (active `hide` labels from me). */
export function useBlocked() {
  const me = useMe();
  const labels = useLabels();
  return useMemo(() => [...myBlocks(me?.key, labels)], [labels, me?.key]);
}

/**
 * Solve the comment's proof of work in the background while the user types, so sending
 * is instant. Must use the same payload/difficulty as the P2P layer (cache hit).
 */
export function useWarmPow(target: string, text: string) {
  const me = useMe();
  const journal = useJournal()?.journal;
  const draft = useDebounced(text.trim(), 500);
  const accepted = useMemo(() => journal?.filter((e) => e.type === 'comment').length ?? 0, [journal]);
  useEffect(() => {
    if (!me || !draft) return;
    warmPow(commentPowPayload(me.key, target, draft), powDifficulty({ accepted })).catch(() => {});
  }, [me, target, draft, accepted]);
}

/** Debounced value (composer → background proof of work). */
export function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
