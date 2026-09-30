// `local` implementation of the P2P contract: single device, AsyncStorage + Keychain.
// Same data model as the future `bare` worklet (signed records, hash-chained journal,
// proof of work on comments), so switching is only a transport change. Demo peers from
// ./demo make every social screen usable offline; direct messages to them loop back.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ExpoDevice from 'expo-device';

import { blake2b } from '@noble/hashes/blake2.js';

import {
  bytesToHex,
  deviceKeysFromSeed,
  fingerprint,
  hexToBytes,
  isValidPhrase,
  phraseFromEntropy,
  rootKeysFromPhrase,
  sign,
  utf8ToBytes,
} from '@/social/identity';
import { migrateLegacy, seriesOfTarget, type LegacyState } from '@/social/migrate';
import { commentPowPayload, powDifficulty, warmPow, type PowProof } from '@/social/pow';
import { rateWait } from '@/social/rate';

import type {
  BackupState,
  Conversation,
  Device,
  DirectMessage,
  JournalEntry,
  Label,
  P2P,
  P2PComment,
  P2PStatus,
  Profile,
  PublicKey,
} from './contract';
import { DEMO_WELCOME, demoComments, demoJournal, demoKeyOf, demoLabels, demoProfile, demoReply, isDemoKey } from './demo';
import { randomBytes, secure } from './secure';

const DB_KEY = 'huwa/p2p/local/v1';
const LEGACY_KEY = 'huwa/state/v1';
const K_PHRASE = 'huwa.identity.phrase';
const K_ROOT = 'huwa.identity.root';
const K_DEVICE = 'huwa.device.seed';

const MAX_COMMENT = 2000;
const MAX_DM = 4000;

type StoredComment = Omit<P2PComment, 'likedByMe'> & { pow?: PowProof; sig?: string };
type SignedEntry = { e: JournalEntry; prev: string; hash: string; sig: string };

type DB = {
  v: 1;
  profile?: Profile;
  devices: Device[];
  phraseVerified: boolean;
  invites: { token: string; exp: number }[];
  comments: Record<string, StoredComment[]>;
  likes: Record<string, true>;
  labels: Label[];
  follows: string[];
  subscriptions: string[];
  dms: Record<string, DirectMessage[]>;
  reads: Record<string, number>;
  peerNames: Record<string, string>;
  journal: SignedEntry[];
  migrated: boolean;
};

const empty = (): DB => ({
  v: 1, devices: [], phraseVerified: false, invites: [], comments: {}, likes: {}, labels: [], follows: [],
  subscriptions: [], dms: {}, reads: {}, peerNames: {}, journal: [], migrated: false,
});

const hex = (n: number) => bytesToHex(randomBytes(n));
const hashHex = (s: string) => bytesToHex(blake2b(utf8ToBytes(s), { dkLen: 32 }));
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${hex(4)}`;

function checkName(name: string) {
  const n = name.trim().replace(/\s+/g, ' ');
  if (n.length < 2) throw new Error('Choisis un pseudo d’au moins 2 caractères.');
  if (n.length > 24) throw new Error('24 caractères maximum.');
  return n;
}

export function createLocalP2P(): P2P {
  let db: DB = empty();
  let secret: Uint8Array | undefined;
  let status: P2PStatus = { state: 'starting', peers: 0 };

  const statusL = new Set<(s: P2PStatus) => void>();
  const commentL = new Map<string, Set<(all: P2PComment[]) => void>>();
  const labelL = new Set<(l: Label[]) => void>();
  const convL = new Set<(c: Conversation[]) => void>();
  const msgL = new Map<string, Set<(m: DirectMessage[]) => void>>();

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => AsyncStorage.setItem(DB_KEY, JSON.stringify(db)).catch(() => {});
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 250);
  };

  const setStatus = (s: P2PStatus) => {
    status = s;
    statusL.forEach((l) => l(s));
  };

  const ready = (async () => {
    try {
      const raw = await AsyncStorage.getItem(DB_KEY);
      if (raw) db = { ...empty(), ...JSON.parse(raw) };
      if (db.profile) {
        const root = await secure.get(K_ROOT);
        if (root) secret = hexToBytes(root);
        else {
          const phrase = await secure.get(K_PHRASE);
          if (phrase) secret = rootKeysFromPhrase(phrase.split(' ')).secretKey;
        }
      }
      // Local mode: no network, zero peers, but everything works on this device.
      setStatus({ state: 'ready', peers: 0 });
    } catch (e) {
      setStatus({ state: 'error', peers: 0, error: e instanceof Error ? e.message : String(e) });
    }
  })();

  const me = () => (secret && db.profile ? db.profile : undefined);
  const requireMe = () => {
    const p = me();
    if (!p || !secret) throw new Error('Crée ou restaure ton identité d’abord.');
    return { profile: p, secret };
  };

  // ---------- emitters ----------

  const commentsOf = (seriesId: string): P2PComment[] =>
    ([...(db.comments[seriesId] ?? []), ...demoComments(seriesId)] as StoredComment[]).map(({ pow: _p, sig: _s, ...c }) => {
      const liked = !!db.likes[c.id];
      return { ...c, likes: c.likes + (liked ? 1 : 0), likedByMe: liked };
    });
  const emitComments = (seriesId: string) => {
    const set = commentL.get(seriesId);
    if (!set?.size) return;
    const all = commentsOf(seriesId);
    set.forEach((cb) => cb(all));
  };

  const labelsView = () => [...db.labels, ...db.subscriptions.flatMap(demoLabels)];
  const emitLabels = () => {
    const l = labelsView();
    labelL.forEach((cb) => cb(l));
  };

  const nameOf = (key: string) =>
    key === db.profile?.key ? db.profile.name : (demoProfile(key)?.name ?? db.peerNames[key] ?? `pair ${fingerprint(key)}`);

  const conversations = (): Conversation[] => {
    const myKey = db.profile?.key;
    return Object.entries(db.dms)
      .filter(([, list]) => list.length)
      .map(([peer, list]) => {
        const last = list[list.length - 1];
        const read = db.reads[peer] ?? 0;
        return {
          peer,
          peerName: peer === myKey ? 'Notes pour moi' : nameOf(peer),
          lastText: last.text,
          lastAt: last.createdAt,
          unread: list.filter((m) => m.from === peer && peer !== myKey && m.createdAt > read).length,
          request: peer !== myKey && !db.follows.includes(peer) && !list.some((m) => m.from === myKey),
        };
      })
      .sort((a, b) => b.lastAt - a.lastAt);
  };
  const emitDMs = (peer: string) => {
    const c = conversations();
    convL.forEach((cb) => cb(c));
    const m = db.dms[peer] ?? [];
    msgL.get(peer)?.forEach((cb) => cb([...m]));
  };

  const watch = <T>(map: Map<string, Set<T>>, key: string, cb: T) => {
    const set = map.get(key) ?? new Set<T>();
    set.add(cb);
    map.set(key, set);
    return () => {
      set.delete(cb);
    };
  };

  // ---------- journal ----------

  function appendSigned(e: JournalEntry) {
    const last = db.journal[db.journal.length - 1];
    // Declared timestamps are increasing per writer (replay rejects backdated entries).
    const entry = { ...e, ts: Math.max(e.ts, last?.e.ts ?? 0) } as JournalEntry;
    if (entry.type !== 'comment' && db.journal.some((x) => x.e.type === entry.type && x.e.work === entry.work && 'unit' in x.e && x.e.unit === entry.unit)) return;
    const prev = last?.hash ?? '';
    const hash = hashHex(`${JSON.stringify(entry)}|${prev}`);
    db.journal.push({ e: entry, prev, hash, sig: secret ? sign(hash, secret) : '' });
  }

  async function migrate(profile: Profile) {
    if (db.migrated) return;
    let legacy: LegacyState = {};
    try {
      const raw = await AsyncStorage.getItem(LEGACY_KEY);
      if (raw) legacy = JSON.parse(raw);
    } catch {}
    const m = migrateLegacy(legacy, { key: profile.key, name: profile.name });
    for (const c of m.comments) {
      const sid = seriesOfTarget(c.target);
      const list = db.comments[sid] ?? [];
      if (!list.some((x) => x.id === c.id)) list.push({ ...c, sig: secret ? sign(hashHex(JSON.stringify(c)), secret) : undefined });
      db.comments[sid] = list.sort((a, b) => b.createdAt - a.createdAt);
    }
    Object.assign(db.likes, m.likes);
    for (const e of m.journal) appendSigned(e);
    db.migrated = true;
  }

  async function adopt(words: string[], profile: Profile, verified: boolean) {
    const keys = rootKeysFromPhrase(words);
    await secure.set(K_PHRASE, words.join(' '));
    await secure.set(K_ROOT, bytesToHex(keys.secretKey));
    let deviceSeed = await secure.get(K_DEVICE);
    if (!deviceSeed) {
      deviceSeed = hex(32);
      await secure.set(K_DEVICE, deviceSeed);
    }
    const device = deviceKeysFromSeed(hexToBytes(deviceSeed));
    secret = keys.secretKey;
    if (db.profile?.key !== profile.key) {
      db.devices = [];
      db.migrated = false;
    }
    db.profile = profile;
    db.phraseVerified = verified || (db.phraseVerified && db.profile.key === profile.key);
    if (!db.devices.some((d) => d.key === device.publicKey)) {
      db.devices.unshift({
        key: device.publicKey,
        name: ExpoDevice.deviceName ?? ExpoDevice.modelName ?? 'Cet appareil',
        addedAt: Date.now(),
        current: true,
      });
    }
    await migrate(profile);
    await persist();
    setStatus({ ...status });
  }

  function legacyName(legacy?: string | null) {
    try {
      const name = legacy ? (JSON.parse(legacy) as LegacyState).userName : undefined;
      return name && name !== 'moi' ? name : undefined;
    } catch {
      return undefined;
    }
  }

  function receive(peer: string, text: string) {
    const myKey = db.profile?.key;
    if (!myKey) return;
    const list = db.dms[peer] ?? [];
    list.push({ id: newId('dm'), from: peer, to: myKey, text, createdAt: Date.now(), delivered: true });
    db.dms[peer] = list;
    save();
    emitDMs(peer);
  }

  const p2p: P2P = {
    status: () => status,
    onStatus(cb) {
      statusL.add(cb);
      return () => {
        statusL.delete(cb);
      };
    },

    // ---------- identity ----------

    me,

    async createIdentity(name) {
      await ready;
      const clean = checkName(name);
      const words = phraseFromEntropy(randomBytes(32));
      const { publicKey } = rootKeysFromPhrase(words);
      const profile: Profile = { key: publicKey, name: clean, createdAt: Date.now(), fingerprint: fingerprint(publicKey) };
      await adopt(words, profile, false);
      // Local test loop: a demo peer says hello, so "requests" can be tried.
      const welcomeFrom = demoKeyOf(DEMO_WELCOME.name);
      if (!db.dms[welcomeFrom]) setTimeout(() => receive(welcomeFrom, DEMO_WELCOME.text), 4000);
      return { profile, phrase: words };
    },

    async restoreIdentity(phrase) {
      await ready;
      const words = phrase.map((w) => w.trim().toLowerCase()).filter(Boolean);
      if (!isValidPhrase(words)) throw new Error('Phrase invalide : vérifie l’orthographe et l’ordre des 24 mots.');
      const { publicKey } = rootKeysFromPhrase(words);
      const known = db.profile?.key === publicKey ? db.profile : undefined;
      const profile: Profile = known ?? {
        key: publicKey,
        name: legacyName(await AsyncStorage.getItem(LEGACY_KEY)) ?? `huwa-${fingerprint(publicKey).slice(0, 4)}`,
        createdAt: Date.now(),
        fingerprint: fingerprint(publicKey),
      };
      // Typing the 24 words back proves the phrase is written down.
      await adopt(words, profile, true);
      return profile;
    },

    async updateProfile(patch) {
      await ready;
      const { profile } = requireMe();
      const next: Profile = { ...profile };
      if (patch.name != null) next.name = checkName(patch.name);
      if (patch.bio != null) {
        const bio = patch.bio.trim();
        if (bio.length > 160) throw new Error('Bio : 160 caractères maximum.');
        next.bio = bio || undefined;
      }
      if (patch.avatar != null) next.avatar = patch.avatar.slice(0, 512) || undefined;
      db.profile = next;
      await persist();
      setStatus({ ...status });
      return next;
    },

    async getProfile(key) {
      await ready;
      if (key === db.profile?.key) return db.profile;
      const demo = demoProfile(key);
      if (demo) return demo;
      const name = db.peerNames[key];
      return name ? { key, name, createdAt: 0, fingerprint: fingerprint(key) } : undefined;
    },

    async backupState(): Promise<BackupState> {
      await ready;
      return { cloud: false, phraseVerified: db.phraseVerified, devices: db.devices.filter((d) => !d.revoked).length };
    },

    async markPhraseVerified() {
      await ready;
      requireMe();
      db.phraseVerified = true;
      await persist();
    },

    async devices() {
      await ready;
      return db.devices.map((d) => ({ ...d }));
    },

    async pairingInvite() {
      await ready;
      const { profile } = requireMe();
      const token = hex(16);
      const exp = Date.now() + 10 * 60_000;
      db.invites = [...db.invites.filter((i) => i.exp > Date.now()), { token, exp }];
      save();
      return `huwa-pair:1:${profile.key}:${token}:${exp}`;
    },

    async acceptPairing(invite) {
      await ready;
      const m = /^huwa-pair:1:([0-9a-f]{64}):([0-9a-f]{32}):(\d+)$/.exec(invite.trim());
      if (!m) throw new Error('Ce QR code n’est pas une invitation Huwa.');
      const [, root, token, exp] = m;
      if (Number(exp) < Date.now()) throw new Error('Invitation expirée : génère un nouveau QR code sur l’autre appareil.');
      const mine = db.invites.find((i) => i.token === token);
      if (mine && root === db.profile?.key) {
        // Loopback (same device): simulates enrolling a second device for testing.
        db.invites = db.invites.filter((i) => i !== mine);
        const sim = deviceKeysFromSeed(randomBytes(32));
        db.devices.push({ key: sim.publicKey, name: 'Appareil de test (boucle locale)', addedAt: Date.now(), current: false });
        await persist();
        return db.profile;
      }
      throw new Error('L’appairage entre deux appareils passe par le réseau P2P, pas encore actif dans cette version. Utilise ta phrase de récupération.');
    },

    async revokeDevice(deviceKey) {
      await ready;
      requireMe();
      const d = db.devices.find((x) => x.key === deviceKey);
      if (!d) throw new Error('Appareil inconnu.');
      if (d.current) throw new Error('Impossible de révoquer l’appareil que tu utilises.');
      d.revoked = true;
      await persist();
    },

    // ---------- comments ----------

    watchComments(seriesId, cb) {
      const off = watch(commentL, seriesId, cb);
      ready.then(() => {
        if (commentL.get(seriesId)?.has(cb)) cb(commentsOf(seriesId));
      });
      return off;
    },

    async postComment(c) {
      await ready;
      const { profile, secret: sk } = requireMe();
      const text = c.text.trim();
      if (!text) throw new Error('Commentaire vide.');
      if (text.length > MAX_COMMENT) throw new Error(`${MAX_COMMENT} caractères maximum.`);
      const mine = Object.values(db.comments).flat().filter((x) => x.author === profile.key);
      const now = Date.now();
      const wait = rateWait(mine.map((x) => x.createdAt), now);
      if (wait > 0) throw new Error(`Patiente ${Math.ceil(wait / 1000)} s avant de publier à nouveau.`);

      const seriesId = seriesOfTarget(c.target);
      const pow = await warmPow(commentPowPayload(profile.key, c.target, text), powDifficulty({ accepted: mine.length }));
      let fromAnime = false;
      if (c.target.startsWith('ch:')) {
        const eps = db.journal.some((x) => x.e.type === 'ep' && x.e.work === seriesId);
        fromAnime = eps;
      }
      const body: Omit<StoredComment, 'sig' | 'pow'> = {
        id: newId(profile.key.slice(0, 8)),
        target: c.target,
        parentId: c.parentId,
        author: profile.key,
        authorName: profile.name,
        text,
        createdAt: mine.reduce((t, x) => Math.max(t, x.createdAt + 1), now),
        likes: 0,
        spoiler: !!c.spoiler,
        timestamp: c.timestamp,
        fromAnime: fromAnime || undefined,
      };
      const stored: StoredComment = { ...body, pow, sig: sign(hashHex(JSON.stringify(body)), sk) };
      db.comments[seriesId] = [stored, ...(db.comments[seriesId] ?? [])];
      save();
      emitComments(seriesId);
      return { ...body, likedByMe: false };
    },

    async toggleLike(seriesId, commentId) {
      await ready;
      requireMe();
      if (db.likes[commentId]) delete db.likes[commentId];
      else db.likes[commentId] = true;
      save();
      emitComments(seriesId);
    },

    async editComment(seriesId, commentId, patch) {
      await ready;
      const { profile, secret: sk } = requireMe();
      const text = patch.text.trim();
      if (!text) throw new Error('Commentaire vide.');
      if (text.length > MAX_COMMENT) throw new Error(`${MAX_COMMENT} caractères maximum.`);
      const list = db.comments[seriesId] ?? [];
      const i = list.findIndex((x) => x.id === commentId);
      if (i < 0 || list[i].author !== profile.key || list[i].deleted) throw new Error('Tu ne peux modifier que tes propres commentaires.');
      const { pow: _p, sig: _s, ...body } = list[i];
      const next = { ...body, text, spoiler: patch.spoiler, editedAt: Date.now() };
      list[i] = { ...next, sig: sign(hashHex(JSON.stringify(next)), sk) };
      save();
      emitComments(seriesId);
    },

    async deleteComment(seriesId, commentId) {
      await ready;
      const { profile, secret: sk } = requireMe();
      const list = db.comments[seriesId] ?? [];
      const i = list.findIndex((x) => x.id === commentId);
      if (i < 0 || list[i].author !== profile.key) throw new Error('Tu ne peux supprimer que tes propres commentaires.');
      const { pow: _p, sig: _s, ...body } = list[i];
      const next = { ...body, text: '', spoiler: false, deleted: true, editedAt: Date.now() };
      list[i] = { ...next, sig: sign(hashHex(JSON.stringify(next)), sk) };
      delete db.likes[commentId];
      save();
      emitComments(seriesId);
    },

    // ---------- moderation ----------

    async follow(key) {
      await ready;
      if (!db.follows.includes(key)) db.follows.push(key);
      save();
      Object.keys(db.dms).forEach(emitDMs);
    },
    async unfollow(key) {
      await ready;
      db.follows = db.follows.filter((k) => k !== key);
      save();
      Object.keys(db.dms).forEach(emitDMs);
    },
    async block(key) {
      await ready;
      const { profile } = requireMe();
      if (key === profile.key) throw new Error('Tu ne peux pas te bloquer toi-même.');
      db.labels.push({ by: profile.key, target: key, val: 'hide', ts: Date.now() });
      db.follows = db.follows.filter((k) => k !== key);
      save();
      emitLabels();
    },
    async unblock(key) {
      await ready;
      const { profile } = requireMe();
      db.labels.push({ by: profile.key, target: key, val: 'hide', neg: true, ts: Date.now() });
      save();
      emitLabels();
    },
    async report(target, val) {
      await ready;
      const { profile } = requireMe();
      db.labels.push({ by: profile.key, target, val, ts: Date.now() });
      save();
      emitLabels();
    },
    watchLabels(cb) {
      labelL.add(cb);
      ready.then(() => {
        if (labelL.has(cb)) cb(labelsView());
      });
      return () => {
        labelL.delete(cb);
      };
    },
    async subscribeLabeler(key) {
      await ready;
      if (!db.subscriptions.includes(key)) db.subscriptions.push(key);
      save();
      emitLabels();
    },

    // ---------- direct messages ----------

    watchConversations(cb) {
      convL.add(cb);
      ready.then(() => {
        if (convL.has(cb)) cb(conversations());
      });
      return () => {
        convL.delete(cb);
      };
    },
    watchMessages(peer, cb) {
      const off = watch(msgL, peer, cb);
      ready.then(() => {
        if (msgL.get(peer)?.has(cb)) cb([...(db.dms[peer] ?? [])]);
      });
      return off;
    },
    async sendMessage(peer, text) {
      await ready;
      const { profile } = requireMe();
      const body = text.trim();
      if (!body) throw new Error('Message vide.');
      if (body.length > MAX_DM) throw new Error(`${MAX_DM} caractères maximum.`);
      const self = peer === profile.key;
      const msg: DirectMessage = { id: newId('dm'), from: profile.key, to: peer, text: body, createdAt: Date.now(), delivered: self };
      const list = db.dms[peer] ?? [];
      list.push(msg);
      db.dms[peer] = list;
      db.reads[peer] = msg.createdAt;
      const known = await p2p.getProfile(peer);
      if (known && !isDemoKey(peer)) db.peerNames[peer] = known.name;
      save();
      emitDMs(peer);
      if (!self && isDemoKey(peer)) {
        // Simulated delivery + answer (the real transport lands with the Bare worklet).
        setTimeout(() => {
          msg.delivered = true;
          save();
          emitDMs(peer);
        }, 700);
        const reply = demoReply(peer, list.length);
        if (reply) setTimeout(() => receive(peer, reply), 2200);
      }
      return { ...msg };
    },
    async markRead(peer) {
      await ready;
      db.reads[peer] = Date.now();
      save();
      emitDMs(peer);
    },

    // ---------- journal ----------

    async appendJournal(e) {
      await ready;
      requireMe();
      appendSigned(e);
      save();
    },
    async journal(key?: PublicKey) {
      await ready;
      if (!key || key === db.profile?.key) return db.journal.map((x) => x.e);
      return demoJournal(key);
    },
  };

  return p2p;
}
