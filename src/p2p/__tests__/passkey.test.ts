/// <reference types="node" />
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import {
  aaguidFromAttestation,
  decodePayload,
  deriveKey,
  encodePayload,
  fromBase64,
  hintLabel,
  loginWithPasskey,
  openPhrase,
  parseHint,
  PasskeyError,
  prfSalt,
  providerName,
  sealPhrase,
  setupPasskey,
  toBase64,
  userIdFor,
  type Aead,
  type PasskeyNative,
} from '../passkey-core';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const PHRASE = [...Array(23).fill('abandon'), 'art'];
const PRF = Uint8Array.from({ length: 32 }, (_, i) => i);

/** Same layout as expo-crypto (ciphertext‖tag, 16-byte tag). */
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
const fixedRandom = (n: number) => new Uint8Array(n).fill(7);

test('AES-256-GCM adapter matches the NIST vector (McGrew-Viega test case 14)', async () => {
  const out = await nodeAead.seal(new Uint8Array(32), new Uint8Array(12), new Uint8Array(16), new Uint8Array());
  assert.equal(hex(out), 'cea7403d4d606b6e074ec5d3baf39d18' + 'd0d1c8a799996bf0265b98b5d48ab919');
});

test('salt, user handle and key derivation vectors', () => {
  assert.equal(hex(prfSalt()), 'a861b6fe9410e34039629df86d49112202a43e92af2068b609908231d03cc3ce');
  assert.equal(hex(deriveKey(PRF)), 'a3df2f673fd3832b73007a791748b7cb3b4a214520a9197ee70b6aa047d8f95c');
  // Cross-check with node's HKDF.
  const ref = Buffer.from(crypto.hkdfSync('sha256', PRF, Buffer.from('huwa-passkey-v1'), Buffer.from('huwa/passkey/phrase-key/v1'), 32));
  assert.equal(hex(deriveKey(PRF)), ref.toString('hex'));
  assert.equal(userIdFor('a'.repeat(64)).length, 16);
  assert.deepEqual(userIdFor('k1'), userIdFor('k1'));
  assert.notDeepEqual(userIdFor('k1'), userIdFor('k2'));
  assert.throws(() => deriveKey(new Uint8Array(16)), PasskeyError);
});

test('base64 round trip and known values', () => {
  for (let n = 0; n < 40; n++) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
    assert.equal(toBase64(b), Buffer.from(b).toString('base64'));
    assert.deepEqual(fromBase64(toBase64(b)), b);
  }
  assert.deepEqual(fromBase64('-_8'), Uint8Array.from([251, 255])); // base64url accepted
  assert.throws(() => fromBase64('a$b'), PasskeyError);
});

test('PRF payload: deterministic vector, round trip, under 1 KB', async () => {
  const p = await sealPhrase(PHRASE, { prf: PRF, aead: nodeAead, random: fixedRandom });
  assert.equal(p.enc, 'prf-aes256gcm');
  assert.ok(p.enc === 'prf-aes256gcm');
  assert.equal(p.n, 'BwcHBwcHBwcHBwcH');
  assert.equal(
    p.c,
    'pM/chmZB7uice6+R54fnmJ5/VTZDBhCXbnE6dzcKEqwXbIkuFYFsFZYqrGaqpZzD1P4w6ppdhnDj6TfR2Ekoyj5xc+7jEuKb3dAO8yB0WraE60zZ8rt6zpVjHbYckcjSSJSEFgn04KU3ocEElFAkFMX9gKyUqjqGFuOFN2fdtZ3WHXjLZeSR6LgKE+JYjnuYXt/OQgMhTklnW6ci7QGIkcXw6WqBbJlsz1/Kyc9EjBzgyE6YjMq9gJspy2mAB108IWOWzG5G8G+0Cfc=',
  );
  const bytes = encodePayload(p);
  assert.ok(bytes.length < 1024);
  assert.deepEqual(await openPhrase(decodePayload(bytes), { prf: PRF, aead: nodeAead }), PHRASE);
});

test('PRF payload: wrong key, missing PRF, tampering', async () => {
  const p = await sealPhrase(PHRASE, { prf: PRF, aead: nodeAead, random: fixedRandom });
  const other = PRF.map((b) => b ^ 1);
  await assert.rejects(openPhrase(p, { prf: other, aead: nodeAead }), { code: 'decrypt-failed' });
  await assert.rejects(openPhrase(p, { aead: nodeAead }), { code: 'prf-unavailable' });
  assert.ok(p.enc === 'prf-aes256gcm');
  const c = fromBase64(p.c);
  c[0] ^= 1;
  await assert.rejects(openPhrase({ ...p, c: toBase64(c) }, { prf: PRF, aead: nodeAead }), { code: 'decrypt-failed' });
});

test('plain payload (no PRF) and malformed blobs', async () => {
  const p = await sealPhrase(PHRASE, { aead: nodeAead, random: fixedRandom });
  assert.deepEqual(p, { v: 1, enc: 'none', phrase: PHRASE.join(' ') });
  assert.deepEqual(await openPhrase(decodePayload(encodePayload(p)), { aead: nodeAead }), PHRASE);
  const enc = (s: string) => new TextEncoder().encode(s);
  assert.throws(() => decodePayload(new Uint8Array()), { code: 'no-blob' });
  assert.throws(() => decodePayload(enc('nope')), { code: 'bad-blob' });
  assert.throws(() => decodePayload(enc('{"v":2,"enc":"none","phrase":"x"}')), { code: 'bad-blob' });
  assert.throws(() => decodePayload(enc('{"v":1,"enc":"rot13"}')), { code: 'bad-blob' });
  await assert.rejects(openPhrase({ v: 1, enc: 'none', phrase: 'abandon abandon' }, { aead: nodeAead }), { code: 'bad-blob' });
  await assert.rejects(sealPhrase(['abandon'], { aead: nodeAead, random: fixedRandom }), PasskeyError);
});

/** Hand-built attestation object: {fmt: "none", attStmt: {}, authData}. */
function attestation(aaguid: string) {
  const authData = new Uint8Array(32 + 1 + 4 + 16 + 2 + 4);
  authData[32] = 0x45; // UP | UV | AT
  authData.set(Buffer.from(aaguid.replace(/-/g, ''), 'hex'), 37);
  authData[54] = 4;
  const enc = new TextEncoder();
  return Uint8Array.from([
    0xa3,
    0x63, ...enc.encode('fmt'), 0x64, ...enc.encode('none'),
    0x67, ...enc.encode('attStmt'), 0xa0,
    0x68, ...enc.encode('authData'), 0x58, authData.length, ...authData,
  ]);
}

test('AAGUID → password manager name', () => {
  const icloud = 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd';
  assert.equal(aaguidFromAttestation(attestation(icloud)), icloud);
  assert.equal(providerName(aaguidFromAttestation(attestation(icloud))), 'Trousseau iCloud');
  assert.equal(providerName(aaguidFromAttestation(attestation('bada5566-a7aa-401f-bd96-45619a55120d'))), '1Password');
  assert.equal(aaguidFromAttestation(attestation('00000000-0000-0000-0000-000000000000')), undefined);
  assert.equal(aaguidFromAttestation(Uint8Array.from([0xff, 0x00])), undefined);
  assert.equal(providerName('12345678-0000-0000-0000-000000000000'), undefined);
});

// ---------- flows against a fake provider ----------

type Provider = { largeBlob: boolean; prf: boolean; prfAtCreate: boolean; failAt?: 'register' | 'authenticate' | 'write'; write?: boolean };

function fakeNative(p: Provider) {
  const store = new Map<string, { blob?: Uint8Array; secret: Uint8Array; user: Uint8Array }>();
  const calls: string[] = [];
  const evalPrf = (secret: Uint8Array, salt: Uint8Array) => new Uint8Array(crypto.createHmac('sha256', secret).update(salt).digest());
  const cancel = () => Object.assign(new Error('The operation couldn’t be completed.'), { code: 'cancelled' });
  const native: PasskeyNative = {
    async register(o) {
      calls.push('register');
      if (p.failAt === 'register') throw cancel();
      const id = toBase64(crypto.randomBytes(16));
      const secret = new Uint8Array(crypto.randomBytes(32));
      store.set(id, { secret, user: o.userId });
      return {
        credentialId: id,
        attestationObject: attestation('fbfc3007-154e-4ecc-8c0b-6e020557d7bd'),
        largeBlob: p.largeBlob,
        prf: p.prf,
        prfFirst: p.prf && p.prfAtCreate ? evalPrf(secret, o.prfSalt) : undefined,
      };
    },
    async writeBlob(o) {
      calls.push('write');
      if (p.failAt === 'write') throw cancel();
      const c = store.get(o.credentialId)!;
      if (p.write === false) return { written: false };
      c.blob = o.data;
      return { written: true };
    },
    async authenticate(o) {
      calls.push(o.readBlob ? 'read' : 'unlock');
      if (p.failAt === 'authenticate') throw cancel();
      const [id, c] = o.credentialId ? [o.credentialId, store.get(o.credentialId)!] : [...store.entries()].at(-1) ?? [];
      if (!id || !c) throw Object.assign(new Error('none'), { code: 'no-credentials' });
      return {
        credentialId: id,
        userHandle: c.user,
        blob: o.readBlob ? c.blob : undefined,
        prfFirst: p.prf && o.prfSalt ? evalPrf(c.secret, o.prfSalt) : undefined,
      };
    },
  };
  return { native, calls, store };
}

const USER = { key: 'b'.repeat(64), name: 'mira.reads', fingerprint: 'k3xa9fmo' };
const deps = (native: PasskeyNative, steps: string[] = []) => ({
  native,
  aead: nodeAead,
  random: (n: number) => new Uint8Array(crypto.randomBytes(n)),
  now: () => 1_700_000_000_000,
  onStep: (s: string) => steps.push(s),
});

test('setup with PRF evaluated at creation: 2 prompts, encrypted, then login on "another device"', async () => {
  const { native, calls } = fakeNative({ largeBlob: true, prf: true, prfAtCreate: true });
  const steps: string[] = [];
  const rec = await setupPasskey(USER, PHRASE, deps(native, steps));
  assert.deepEqual(calls, ['register', 'write']);
  assert.deepEqual(steps, ['register', 'write', 'done']);
  assert.equal(rec.enc, 'prf-aes256gcm');
  assert.equal(rec.provider, 'Trousseau iCloud');
  assert.equal(rec.createdAt, 1_700_000_000_000);
  const login = await loginWithPasskey(deps(native));
  assert.deepEqual(login.words, PHRASE);
  assert.equal(login.credentialId, rec.credentialId);
});

test('setup with PRF only at assertion: extra unlock prompt', async () => {
  const { native, calls } = fakeNative({ largeBlob: true, prf: true, prfAtCreate: false });
  const rec = await setupPasskey(USER, PHRASE, deps(native));
  assert.deepEqual(calls, ['register', 'unlock', 'write']);
  assert.equal(rec.enc, 'prf-aes256gcm');
  assert.deepEqual((await loginWithPasskey(deps(native))).words, PHRASE);
});

test('setup without PRF stores the phrase in the (provider-encrypted) blob', async () => {
  const { native, store } = fakeNative({ largeBlob: true, prf: false, prfAtCreate: false });
  const rec = await setupPasskey(USER, PHRASE, deps(native));
  assert.equal(rec.enc, 'none');
  assert.equal(rec.prf, false);
  const blob = store.get(rec.credentialId)!.blob!;
  assert.equal(decodePayload(blob).enc, 'none');
  assert.deepEqual((await loginWithPasskey(deps(native))).words, PHRASE);
});

test('provider without largeBlob → no-large-blob with the useless credential id', async () => {
  const { native, calls } = fakeNative({ largeBlob: false, prf: true, prfAtCreate: true });
  const err = await setupPasskey(USER, PHRASE, deps(native)).catch((e) => e);
  assert.equal(err.code, 'no-large-blob');
  assert.ok(err.credentialId);
  assert.deepEqual(calls, ['register']);
});

test('cancellations and failures are typed', async () => {
  const cancelled = await setupPasskey(USER, PHRASE, deps(fakeNative({ largeBlob: true, prf: false, prfAtCreate: false, failAt: 'register' }).native)).catch((e) => e);
  assert.equal(cancelled.code, 'cancelled');
  assert.equal(cancelled.credentialId, undefined);

  const atWrite = await setupPasskey(USER, PHRASE, deps(fakeNative({ largeBlob: true, prf: false, prfAtCreate: false, failAt: 'write' }).native)).catch((e) => e);
  assert.equal(atWrite.code, 'cancelled');
  assert.ok(atWrite.credentialId, 'credential created before the cancel is reported');

  const notWritten = await setupPasskey(USER, PHRASE, deps(fakeNative({ largeBlob: true, prf: false, prfAtCreate: false, write: false }).native)).catch((e) => e);
  assert.equal(notWritten.code, 'write-failed');

  await assert.rejects(loginWithPasskey(deps(fakeNative({ largeBlob: true, prf: false, prfAtCreate: false }).native)), { code: 'no-credentials' });
  await assert.rejects(setupPasskey(USER, ['abandon'], deps(fakeNative({ largeBlob: true, prf: false, prfAtCreate: false }).native)), PasskeyError);
});

test('login on a passkey without a Huwa blob', async () => {
  const { native } = fakeNative({ largeBlob: true, prf: false, prfAtCreate: false, failAt: undefined });
  await native.register({ userName: 'x', displayName: 'x', userId: new Uint8Array(16), challenge: new Uint8Array(32), prfSalt: prfSalt() });
  await assert.rejects(loginWithPasskey(deps(native)), { code: 'no-blob' });
});

test('account hint parsing is defensive', () => {
  assert.equal(parseHint(null), undefined);
  assert.equal(parseHint('not json'), undefined);
  assert.equal(parseHint('42')?.name, undefined);
  assert.deepEqual(parseHint('{"name":" mira ","fingerprint":"k3xa9fmo","savedAt":5,"passkeyAt":6}'), { name: 'mira', fingerprint: 'k3xa9fmo', savedAt: 5, passkeyAt: 6 });
  assert.deepEqual(parseHint('{"name":3,"savedAt":"x"}'), { name: undefined, fingerprint: undefined, savedAt: 0, passkeyAt: undefined });
  assert.equal(hintLabel({ name: 'mira', savedAt: 0 }).action, 'Continuer en tant que mira');
  assert.equal(hintLabel({ name: 'mira', savedAt: 0 }).initial, 'M');
  assert.equal(hintLabel({ fingerprint: 'k3xa9fmo', savedAt: 0 }).action, 'Continuer avec le compte k3xa9fmo');
  assert.equal(hintLabel(undefined).action, 'Continuer avec ce compte');
});
