/// <reference types="node" />
// Runs the real `local` implementation against in-memory mocks of AsyncStorage,
// SecureStore, expo-crypto and expo-device (see scripts/test-hooks.mjs).
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { demoKey, isValidPhrase } from '../../social/identity';
import { hiddenAuthors } from '../../social/moderation';
import { commentPowPayload, verifyPow } from '../../social/pow';
import { replayJournal } from '../../social/rank';
import type { P2PComment } from '../contract';
import { DEMO_LABELERS } from '../demo';
import { createLocalP2P } from '../local';

const first = <T>(watch: (cb: (v: T) => void) => () => void) =>
  new Promise<T>((resolve) => {
    const off = watch((v) => {
      off();
      resolve(v);
    });
  });

beforeEach(async () => {
  await AsyncStorage.clear();
  for (const k of ['huwa.identity.phrase', 'huwa.identity.root', 'huwa.device.seed']) await SecureStore.deleteItemAsync(k);
});

test('identity: create, reload from storage, restore from phrase', async () => {
  const a = createLocalP2P();
  assert.equal(a.me(), undefined);
  await assert.rejects(a.createIdentity(' x '));
  const { profile, phrase } = await a.createIdentity('  tahar  ');
  assert.equal(profile.name, 'tahar');
  assert.equal(phrase.length, 24);
  assert.ok(isValidPhrase(phrase));
  assert.equal(a.status().state, 'ready');

  // Same storage, new instance (app restart): identity comes back.
  const b = createLocalP2P();
  await first<unknown>((cb) => b.onStatus(cb));
  assert.equal(b.me()?.key, profile.key);

  // Fresh device: restoring the phrase yields the same key and counts as verified.
  await AsyncStorage.clear();
  const c = createLocalP2P();
  const restored = await c.restoreIdentity(phrase);
  assert.equal(restored.key, profile.key);
  assert.equal((await c.backupState()).phraseVerified, true);
  await assert.rejects(c.restoreIdentity([...phrase].reverse()));
});

test('legacy store is migrated without loss', async () => {
  await AsyncStorage.setItem(
    'huwa/state/v1',
    JSON.stringify({
      userName: 'ancien',
      episodes: { '7-e1': { position: 1, duration: 1, done: true, updatedAt: 1_000 } },
      chapters: { '7-c2': { ratio: 1, done: true, updatedAt: 2_000 } },
      comments: [{ id: 'u-1', target: 'ep:7-e1', author: 'ancien', text: 'Mon vieux commentaire', createdAt: 500, likes: 3, spoiler: false }],
      liked: { 'u-1': true },
    }),
  );
  const p = createLocalP2P();
  const { profile } = await p.createIdentity('nouveau');
  const all = await first<P2PComment[]>((cb) => p.watchComments('7', cb));
  const old = all.find((c) => c.id === 'u-1')!;
  assert.equal(old.author, profile.key);
  assert.equal(old.authorName, 'ancien');
  assert.equal(old.likes, 4);
  assert.equal(old.likedByMe, true);
  const journal = await p.journal();
  assert.deepEqual(
    journal.map((e) => e.type),
    ['comment', 'ep', 'ch'],
  );
});

test('comments: proof of work, likes, rate limit', async () => {
  const p = createLocalP2P();
  const { profile } = await p.createIdentity('mira');
  const posted = await p.postComment({ target: 'ep:1-e1', text: 'Superbe épisode', spoiler: true, timestamp: 42 });
  assert.equal(posted.author, profile.key);
  assert.equal(posted.spoiler, true);
  await assert.rejects(p.postComment({ target: 'ep:1-e1', text: 'trop vite', spoiler: false }), /Patiente/);

  // The stored record carries a valid proof for the canonical payload.
  const db = JSON.parse((await new Promise<string | null>((r) => setTimeout(() => AsyncStorage.getItem('huwa/p2p/local/v1').then(r), 300)))!);
  const stored = db.comments['1'][0];
  assert.ok(verifyPow(commentPowPayload(profile.key, 'ep:1-e1', 'Superbe épisode'), stored.pow));

  await p.toggleLike('1', posted.id);
  let all = await first<P2PComment[]>((cb) => p.watchComments('1', cb));
  assert.equal(all.find((c) => c.id === posted.id)?.likes, 1);
  await p.toggleLike('1', posted.id);
  all = await first<P2PComment[]>((cb) => p.watchComments('1', cb));
  assert.equal(all.find((c) => c.id === posted.id)?.likedByMe, false);
});

test('moderation: block/unblock and the default lists hide the demo spammer', async () => {
  const p = createLocalP2P();
  const { profile } = await p.createIdentity('mod');
  const spammer = demoKey('promo_hd_free');
  for (const l of DEMO_LABELERS) await p.subscribeLabeler(l.key);
  let labels = await first((cb: (l: import('../contract').Label[]) => void) => p.watchLabels(cb));
  const subs = DEMO_LABELERS.map((l) => l.key);
  assert.ok(hiddenAuthors({ me: profile.key, labels, subscriptions: subs }).has(spammer));
  assert.ok(!hiddenAuthors({ me: profile.key, labels, subscriptions: subs.slice(0, 1) }).has(spammer));

  const troll = demoKey('nox');
  await p.block(troll);
  labels = await first((cb: (l: import('../contract').Label[]) => void) => p.watchLabels(cb));
  assert.ok(hiddenAuthors({ me: profile.key, labels, subscriptions: [] }).has(troll));
  await p.unblock(troll);
  labels = await first((cb: (l: import('../contract').Label[]) => void) => p.watchLabels(cb));
  assert.ok(!hiddenAuthors({ me: profile.key, labels, subscriptions: [] }).has(troll));
  await assert.rejects(p.block(profile.key));
});

test('direct messages: local loop with a demo peer, requests, read state', async () => {
  const p = createLocalP2P();
  await p.createIdentity('dm');
  const peer = demoKey('kaito_92');
  const sent = await p.sendMessage(peer, 'Salut !');
  assert.equal(sent.delivered, false);
  const reply = await new Promise<import('../contract').DirectMessage[]>((resolve) => {
    const off = p.watchMessages(peer, (m) => {
      if (m.some((x) => x.from === peer)) {
        off();
        resolve(m);
      }
    });
  });
  assert.equal(reply[0].delivered, true);
  const convs = await first((cb: (c: import('../contract').Conversation[]) => void) => p.watchConversations(cb));
  const c = convs.find((x) => x.peer === peer)!;
  assert.equal(c.request, false);
  assert.equal(c.unread, 1);
  await p.markRead(peer);
  const after = await first((cb: (c: import('../contract').Conversation[]) => void) => p.watchConversations(cb));
  assert.equal(after.find((x) => x.peer === peer)?.unread, 0);
});

test('journal: signed chain, dedup, replayable rank', async () => {
  const p = createLocalP2P();
  await p.createIdentity('rank');
  const t = Date.UTC(2026, 3, 1, 20);
  await p.appendJournal({ type: 'ep', work: '9', unit: 1, ts: t });
  await p.appendJournal({ type: 'ep', work: '9', unit: 1, ts: t + 60_000 }); // duplicate → ignored
  await p.appendJournal({ type: 'ep', work: '9', unit: 2, ts: t + 25 * 60_000 });
  const j = await p.journal();
  assert.equal(j.length, 2);
  assert.equal(replayJournal(j).xp, 20);
  assert.ok((await p.journal(demoKey('aria'))).length > 0);
});

test('pairing: loopback invite adds a device, garbage is rejected, revocation', async () => {
  const p = createLocalP2P();
  await p.createIdentity('pair');
  const invite = await p.pairingInvite();
  await assert.rejects(p.acceptPairing('hello'), /QR/);
  await p.acceptPairing(invite);
  await assert.rejects(p.acceptPairing(invite));
  const devices = await p.devices();
  assert.equal(devices.length, 2);
  const other = devices.find((d) => !d.current)!;
  await assert.rejects(p.revokeDevice(devices.find((d) => d.current)!.key));
  await p.revokeDevice(other.key);
  assert.equal((await p.backupState()).devices, 1);
});

test('mapping corrections: one active proposal per field, validated, paced, demo peers', async (t) => {
  const p = createLocalP2P();
  await assert.rejects(p.proposeMapping({ room: 'm1', season: 'al1', field: 'end', to: 30 }), /identité/);
  const { profile } = await p.createIdentity('lectrice');
  t.mock.timers.enable({ apis: ['Date'], now: 1_900_000_000_000 });
  try {
    await p.proposeMapping({ room: 'm1', season: 'al1', field: 'end', to: 30 });
    await assert.rejects(p.proposeMapping({ room: 'm1', season: 'al1', field: 'end', to: 31 }), /Patiente/);
    t.mock.timers.tick(5000);
    await p.proposeMapping({ room: 'm1', season: 'al1', field: 'end', to: 31 });
    t.mock.timers.tick(5000);
    await p.proposeMapping({ room: 'm1', season: 'al1', field: 'ep', ep: 2, from: 3, to: 5 });
    t.mock.timers.tick(5000);
    await assert.rejects(p.proposeMapping({ room: 'm1', season: 'al1', field: 'ep', ep: 2, from: 3, to: 30 }), /invalide/);
    await assert.rejects(p.proposeMapping({ room: 'm 1', season: 'al1', field: 'end', to: 3 }), /invalide/);
  } finally {
    t.mock.timers.reset();
  }
  const all = await first<import('../contract').MappingProposal[]>((cb) => p.watchMapping('m1', cb));
  assert.deepEqual(
    all.map((x) => [x.field, x.ep, x.from, x.to, x.author === profile.key]),
    [['end', undefined, undefined, 31, true], ['ep', 2, 3, 5, true]],
  );
  // Survives a restart.
  await new Promise((r) => setTimeout(r, 400)); // debounced save
  const again = createLocalP2P();
  assert.equal((await first<import('../contract').MappingProposal[]>((cb) => again.watchMapping('m1', cb))).length, 2);
  // Demo peers back the demo season 2.
  const demo = await first<import('../contract').MappingProposal[]>((cb) => p.watchMapping('void', cb));
  assert.equal(demo.filter((x) => x.season === 'void2' && x.to === 88).length, 2);
  assert.ok(demo.every((x) => x.author === demoKey('mira.reads') || x.author === demoKey('kaito_92')));
});

test('a new identity over an orphaned profile starts clean; the phrase brings the old data back', async () => {
  // Earlier tests' instances still have a demo welcome DM scheduled (4 s) that saves their own
  // database: let them fire, then start from empty storage.
  await new Promise((r) => setTimeout(r, 4500));
  await AsyncStorage.clear();
  const a = createLocalP2P();
  const { profile: pa, phrase } = await a.createIdentity('ancien');
  const peer = demoKey('kaito_92');
  await a.sendMessage(peer, 'message de l’ancien compte');
  await new Promise((r) => setTimeout(r, 400)); // debounced save

  // The Keychain lost the keys (the AsyncStorage profile is still there): orphaned profile.
  for (const k of ['huwa.identity.phrase', 'huwa.identity.root']) await SecureStore.deleteItemAsync(k);
  const b = createLocalP2P();
  await first<unknown>((cb) => b.onStatus(cb));
  assert.equal(b.me(), undefined);
  const { profile: pb } = await b.createIdentity('nouveau');
  assert.notEqual(pb.key, pa.key);
  const convs = await first((cb: (c: import('../contract').Conversation[]) => void) => b.watchConversations(cb));
  assert.ok(!convs.some((c) => c.lastText === 'message de l’ancien compte'), 'old DMs not mixed in');
  assert.equal((await b.devices()).length, 1);

  const restored = await b.restoreIdentity(phrase);
  assert.equal(restored.key, pa.key);
  assert.equal(restored.name, 'ancien');
  const back = await first((cb: (c: import('../contract').Conversation[]) => void) => b.watchConversations(cb));
  assert.ok(back.some((c) => c.lastText === 'message de l’ancien compte'), 'old data restored with its phrase');
});
