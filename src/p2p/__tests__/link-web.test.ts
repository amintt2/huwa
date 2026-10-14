/// <reference types="node" />
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import {
  buildLinkUrl,
  isAllowedRelay,
  newLinkKeys,
  newTopic,
  openLinkFrame,
  parseLinkUrl,
  postLinkFrame,
  rendezvousUrl,
  sealLinkFrame,
  waitLinkFrame,
  webCryptoAead,
  type Aead,
} from '../link-web';

const random = (n: number) => new Uint8Array(crypto.randomBytes(n));
const INVITE = 'huwa-pair:' + 'ab'.repeat(60);

// node:crypto AES-GCM, as the phone's expo-crypto adapter does it (ciphertext‖tag).
const nodeAead: Aead = {
  async seal(key, nonce, plaintext, aad) {
    const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
    c.setAAD(aad);
    return new Uint8Array(Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]));
  },
  async open(key, nonce, sealed, aad) {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(aad);
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    return new Uint8Array(Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]));
  },
};

test('QR URL round trip and validation', () => {
  const keys = newLinkKeys(random);
  const topic = newTopic(random);
  const url = buildLinkUrl({ key: keys.publicKey, relay: 'https://huwa.example.org/p2p', topic, name: 'Chrome sur macOS' });
  assert.match(url, /^huwa:\/\/link-web\?k=[A-Za-z0-9_-]{43}&r=https%3A%2F%2Fhuwa\.example\.org%2Fp2p&t=[0-9a-f]{64}&n=Chrome%20sur%20macOS$/);
  const req = parseLinkUrl(url);
  assert.deepEqual([...req.key], [...keys.publicKey]);
  assert.equal(req.relay, 'https://huwa.example.org/p2p');
  assert.equal(req.topic, topic);
  assert.equal(req.name, 'Chrome sur macOS');
  assert.equal(rendezvousUrl(req.relay, topic), 'https://huwa.example.org/p2p/rendezvous/' + topic);

  assert.throws(() => parseLinkUrl('huwa-pair:abcd'), /liaison/);
  assert.throws(() => parseLinkUrl(url.replace(/k=[^&]+/, 'k=AAAA')), /Clé/);
  assert.throws(() => parseLinkUrl(url.replace(/t=[0-9a-f]+/, 't=XYZ')), /incomplet/);
  assert.throws(() => parseLinkUrl(url.replace(/r=[^&]+/, 'r=' + encodeURIComponent('http://evil.example/p2p'))), /https/);
});

test('allowed gateways: https anywhere, plain http only on local / private networks', () => {
  for (const ok of ['https://huwa.mciut.fr/p2p', 'http://localhost:8080/p2p', 'http://192.168.1.20:8080/p2p', 'http://10.0.0.2/p2p', 'http://nas.local/p2p', 'http://172.20.1.1/p2p']) assert.equal(isAllowedRelay(ok), true, ok);
  for (const bad of ['http://huwa.example.org/p2p', 'javascript:alert(1)', 'ftp://x/p2p', 'https://user:pw@host/p2p', 'http://172.32.0.1/p2p', 'not a url']) assert.equal(isAllowedRelay(bad), false, bad);
});

test('the invite sealed by the phone (node:crypto) opens in the browser (WebCrypto), and only there', async () => {
  const keys = newLinkKeys(random);
  const topic = newTopic(random);
  const req = { key: keys.publicKey, relay: 'https://h/p2p', topic };
  const frame = await sealLinkFrame({ invite: INVITE, name: 'iPhone', ts: 1 }, req, { aead: nodeAead, random });
  assert.ok(frame.length < 2000, 'fits the 8 KB rendezvous frame');
  const got = await openLinkFrame(frame, keys, topic, { aead: webCryptoAead });
  assert.equal(got?.invite, INVITE);
  assert.equal(got?.name, 'iPhone');
  assert.equal(await openLinkFrame(frame, newLinkKeys(random), topic, { aead: webCryptoAead }), null, 'other key');
  assert.equal(await openLinkFrame(frame, keys, newTopic(random), { aead: webCryptoAead }), null, 'other topic (AAD)');
  assert.equal(await openLinkFrame('garbage', keys, topic, { aead: webCryptoAead }), null);
  const bad = await sealLinkFrame({ invite: 'javascript:1', ts: 1 }, req, { aead: nodeAead, random });
  assert.equal(await openLinkFrame(bad, keys, topic, { aead: webCryptoAead }), null, 'not an invite');
});

test('waitLinkFrame long-polls, skips foreign frames, returns the invite', async () => {
  const keys = newLinkKeys(random);
  const topic = newTopic(random);
  const req = { key: keys.publicKey, relay: 'https://h/p2p', topic };
  const stranger = await sealLinkFrame({ invite: INVITE, ts: 1 }, { ...req, key: newLinkKeys(random).publicKey }, { aead: nodeAead, random });
  const mine = await sealLinkFrame({ invite: INVITE, ts: 2 }, req, { aead: nodeAead, random });
  const posted: string[] = [];
  const box: string[] = [];
  const fetchFn = async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      posted.push(url);
      box.push(init.body!);
      return { ok: true, status: 201, json: async () => ({}), text: async () => '' };
    }
    const after = Number(new URL(url).searchParams.get('after'));
    const frames = box.map((b, n) => ({ n, data: Buffer.from(b).toString('base64') })).filter((f) => f.n > after);
    return { ok: true, status: 200, json: async () => ({ frames, next: frames.length ? frames[frames.length - 1].n : after }), text: async () => '' };
  };
  await postLinkFrame(req, stranger, fetchFn);
  const waiting = waitLinkFrame(req, keys, { aead: webCryptoAead, fetch: fetchFn, ms: 5000 });
  setTimeout(() => postLinkFrame(req, mine, fetchFn), 50);
  const got = await waiting;
  assert.equal(got.ts, 2);
  assert.equal(posted[0], 'https://h/p2p/rendezvous/' + topic);
});
