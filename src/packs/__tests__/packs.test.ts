/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  classifyLink,
  decodePack,
  encodePack,
  MAX_ENTRIES,
  MAX_JSON_BYTES,
  packAppLink,
  packJson,
  packWebLink,
  parsePackJson,
  parsePackLink,
  validatePack,
  type Pack,
} from '../format';
import { looksPersonal, personalReasons } from '../secrets';

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');

const SAMPLE: Pack = {
  huwaPack: 1,
  name: 'Mon pack',
  description: 'Sous-titres et catalogues',
  author: 'Amin',
  video: [{ manifest: 'https://exemple.org/manifest.json', name: 'Exemple' }, { manifest: 'https://autre.exemple.net/sub/manifest.json' }],
  manga: [{ repo: 'https://exemple.github.io/extensions/0.9/stable', sources: ['SourceA', 'Source_B'], name: 'Dépôt' }],
};

// ---------- validation ----------

test('a valid pack round-trips through validation unchanged', () => {
  assert.deepEqual(validatePack(SAMPLE), SAMPLE);
});

test('URLs are canonicalized and duplicates merged', () => {
  const p = validatePack({
    huwaPack: 1,
    name: '  Pack  ',
    video: [
      { manifest: 'https://exemple.org' },
      { manifest: 'https://exemple.org/manifest.json' },
      { manifest: 'http://EXEMPLE.org/manifest.json?x=1' },
      { manifest: 'https://exemple.org/configure' },
    ],
    manga: [
      { repo: 'https://exemple.github.io/repo/versioning.json', sources: ['A'] },
      { repo: 'https://exemple.github.io/repo/', sources: ['B', 'A'], name: 'Repo' },
    ],
  });
  assert.equal(p.name, 'Pack');
  assert.deepEqual(p.video, [{ manifest: 'https://exemple.org/manifest.json' }]);
  assert.deepEqual(p.manga, [{ repo: 'https://exemple.github.io/repo', sources: ['A', 'B'], name: 'Repo' }]);
});

test('missing lists default to empty, but an empty pack is refused', () => {
  assert.equal(validatePack({ huwaPack: 1, name: 'x', video: [{ manifest: 'https://a.example/manifest.json' }] }).manga.length, 0);
  assert.throws(() => validatePack({ huwaPack: 1, name: 'x', video: [], manga: [] }), /aucune extension/);
});

test('invalid packs are rejected', () => {
  const bad: unknown[] = [
    null,
    [],
    'pack',
    { name: 'x', video: [{ manifest: 'https://a.example/manifest.json' }] }, // no version
    { huwaPack: '1', name: 'x', video: [{ manifest: 'https://a.example/manifest.json' }] },
    { huwaPack: 1, video: [{ manifest: 'https://a.example/manifest.json' }] }, // no name
    { huwaPack: 1, name: '   ', video: [{ manifest: 'https://a.example/manifest.json' }] },
    { huwaPack: 1, name: 42, video: [{ manifest: 'https://a.example/manifest.json' }] },
    { huwaPack: 1, name: 'x', video: {} },
    { huwaPack: 1, name: 'x', video: ['https://a.example/manifest.json'] },
    { huwaPack: 1, name: 'x', video: [{ manifest: 'javascript:alert(1)' }] },
    { huwaPack: 1, name: 'x', video: [{ manifest: 'stremio://a.example/manifest.json' }] },
    { huwaPack: 1, name: 'x', video: [{ manifest: 'file:///etc/passwd' }] },
    { huwaPack: 1, name: 'x', video: [{ manifest: 'http://localhost:7000/manifest.json' }] },
    { huwaPack: 1, name: 'x', video: [{ manifest: 'http://127.0.0.1/manifest.json' }] },
    { huwaPack: 1, name: 'x', video: [{ manifest: 'https://user:pass@a.example/manifest.json' }] },
    { huwaPack: 1, name: 'x', video: [{ manifest: `https://a.example/${'a'.repeat(3000)}/manifest.json` }] },
    { huwaPack: 1, name: 'x', manga: [{ repo: 'ftp://a.example/repo' }] },
    { huwaPack: 1, name: 'x', manga: [{ repo: 'https://a.example/repo', sources: ['../evil'] }] },
    { huwaPack: 1, name: 'x', manga: [{ repo: 'https://a.example/repo', sources: 'A' }] },
    { huwaPack: 1, name: 'x', manga: [{ repo: 'https://a.example/repo', sources: [1] }] },
  ];
  for (const b of bad) assert.throws(() => validatePack(b), /./, JSON.stringify(b)?.slice(0, 80));
});

test('a newer format version asks for an update', () => {
  assert.throws(() => validatePack({ huwaPack: 2, name: 'x', video: [] }), /plus récente/);
});

test('entry limits are enforced', () => {
  const video = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({ manifest: `https://a${i}.example/manifest.json` }));
  assert.throws(() => validatePack({ huwaPack: 1, name: 'x', video }), /50 extensions/);
  assert.equal(validatePack({ huwaPack: 1, name: 'x', video: video.slice(0, MAX_ENTRIES) }).video.length, MAX_ENTRIES);
  const sources = Array.from({ length: 51 }, (_, i) => `S${i}`);
  assert.throws(() => validatePack({ huwaPack: 1, name: 'x', manga: [{ repo: 'https://a.example/r', sources }] }), /50 sources/);
});

test('texts are cleaned and truncated', () => {
  const p = validatePack({ huwaPack: 1, name: `A\u0000B‮C${'x'.repeat(200)}`, description: 'ligne 1\nligne 2', video: [{ manifest: 'https://a.example/manifest.json' }] });
  assert.ok(p.name.startsWith('A B C'));
  assert.equal(p.name.length, 80);
  assert.equal(p.description, 'ligne 1 ligne 2');
});

test('unknown fields are dropped', () => {
  const p = validatePack({ huwaPack: 1, name: 'x', extra: 1, video: [{ manifest: 'https://a.example/manifest.json', evil: true }] });
  assert.equal(packJson(p), '{"huwaPack":1,"name":"x","video":[{"manifest":"https://a.example/manifest.json"}],"manga":[]}');
});

test('pack JSON text: parse errors and size limit', () => {
  assert.throws(() => parsePackJson('{oops'), /JSON illisible/);
  assert.throws(() => parsePackJson(' '.repeat(MAX_JSON_BYTES + 1)), /volumineux/);
  assert.equal(parsePackJson(JSON.stringify(SAMPLE)).name, 'Mon pack');
});

// ---------- payload ----------

test('payload round-trip (compressed when shorter)', () => {
  const d = encodePack(SAMPLE);
  assert.match(d, /^z?[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodePack(d), SAMPLE);
  const big: Pack = { ...SAMPLE, video: Array.from({ length: 30 }, (_, i) => ({ manifest: `https://addon${i}.exemple.org/manifest.json` })) };
  const dz = encodePack(big);
  assert.equal(dz[0], 'z');
  assert.ok(dz.length < b64url(Buffer.from(packJson(big))).length);
  assert.deepEqual(decodePack(dz), validatePack(big));
});

test('plain base64url payloads (no compression) are accepted', () => {
  const d = b64url(Buffer.from(JSON.stringify(SAMPLE)));
  assert.ok(d.startsWith('ey'));
  assert.deepEqual(decodePack(d), SAMPLE);
});

test('payloads compressed elsewhere (browser CompressionStream / zlib deflate-raw) decode', () => {
  const d = `z${b64url(deflateRawSync(Buffer.from(JSON.stringify(SAMPLE))))}`;
  assert.deepEqual(decodePack(d), SAMPLE);
});

test('the site can decode what the app encodes (DecompressionStream deflate-raw)', async () => {
  const d = encodePack({ ...SAMPLE, video: Array.from({ length: 10 }, (_, i) => ({ manifest: `https://a${i}.exemple.org/manifest.json` })) });
  assert.equal(d[0], 'z');
  const stream = new Blob([Buffer.from(d.slice(1), 'base64url')]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const text = await new Response(stream).text();
  assert.equal(JSON.parse(text).name, 'Mon pack');
});

test('broken, truncated and hostile payloads are rejected', () => {
  const d = encodePack(SAMPLE);
  assert.throws(() => decodePack(''), /vide/);
  assert.throws(() => decodePack('abc$def'), /caractères/);
  assert.throws(() => decodePack(d.slice(0, Math.floor(d.length / 2))));
  assert.throws(() => decodePack(b64url(Buffer.from('not json'))), /JSON/);
  assert.throws(() => decodePack(b64url(Buffer.from([0xff, 0xfe, 0x00]))));
  assert.throws(() => decodePack('z'.repeat(60_000)), /trop long/);
  // Decompression bomb: 10 MB of spaces → refused, output stays bounded.
  const bomb = `z${b64url(deflateRawSync(Buffer.alloc(10 * 1024 * 1024, 0x20)))}`;
  assert.ok(bomb.length < 48 * 1024);
  assert.throws(() => decodePack(bomb), /volumineux/);
});

// ---------- links ----------

test('app and site links', () => {
  const d = encodePack(SAMPLE);
  assert.equal(packAppLink({ d }), `huwa://pack?d=${d}`);
  assert.equal(packWebLink({ d }), `https://huwa.mciut.fr/pack.html#${d}`);
  assert.equal(packAppLink({ url: 'https://exemple.org/p.json' }), 'huwa://pack?url=https%3A%2F%2Fexemple.org%2Fp.json');
  assert.equal(packWebLink({ url: 'https://exemple.org/p.json' }), 'https://huwa.mciut.fr/pack.html#url=https%3A%2F%2Fexemple.org%2Fp.json');
});

test('pack links are recognized', () => {
  assert.deepEqual(parsePackLink('huwa://pack?d=eyJabc'), { d: 'eyJabc' });
  assert.deepEqual(parsePackLink('huwa:///pack?d=zAbC_-'), { d: 'zAbC_-' });
  assert.deepEqual(parsePackLink('huwa://pack?url=https%3A%2F%2Fexemple.org%2Fp.json'), { url: 'https://exemple.org/p.json' });
  assert.deepEqual(parsePackLink('https://huwa.mciut.fr/pack.html#zAbC'), { d: 'zAbC' });
  assert.deepEqual(parsePackLink('https://huwa.mciut.fr/pack#d=eyJ'), { d: 'eyJ' });
  assert.deepEqual(parsePackLink('https://huwa.mciut.fr/pack.html#url=https%3A%2F%2Fexemple.org%2Fp.json'), { url: 'https://exemple.org/p.json' });
  assert.equal(parsePackLink('huwa://pack?url=javascript%3Aalert(1)'), undefined);
  assert.equal(parsePackLink('https://evil.example/pack.html#zAbC'), undefined);
  assert.equal(parsePackLink('huwa://addon?url=x'), undefined);
});

test('pasted links are classified', () => {
  const d = encodePack(SAMPLE);
  assert.deepEqual(classifyLink(`https://huwa.mciut.fr/pack.html#${d}`), { kind: 'pack', ref: { d } });
  assert.deepEqual(classifyLink('https://exemple.org/mon-pack.json'), { kind: 'pack', ref: { url: 'https://exemple.org/mon-pack.json' } });
  assert.deepEqual(classifyLink('https://exemple.org/manifest.json'), { kind: 'addon', url: 'https://exemple.org/manifest.json' });
  assert.deepEqual(classifyLink('stremio://exemple.org/manifest.json'), { kind: 'addon', url: 'stremio://exemple.org/manifest.json' });
  assert.deepEqual(classifyLink('exemple.org/manifest.json'), { kind: 'addon', url: 'https://exemple.org/manifest.json' });
  assert.deepEqual(classifyLink('huwa://addon?url=https%3A%2F%2Fexemple.org%2Fmanifest.json'), { kind: 'addon', url: 'https://exemple.org/manifest.json' });
  assert.deepEqual(classifyLink('huwa://install?type=paperback&url=https%3A%2F%2Fexemple.org%2Frepo'), { kind: 'paperback', url: 'https://exemple.org/repo' });
  assert.deepEqual(classifyLink('huwa://paperback?repo=https%3A%2F%2Fexemple.org%2Frepo'), { kind: 'paperback', url: 'https://exemple.org/repo' });
  assert.deepEqual(classifyLink('https://exemple.github.io/extensions/versioning.json'), { kind: 'paperback', url: 'https://exemple.github.io/extensions/versioning.json' });
  assert.deepEqual(classifyLink('paperback://addRepo?url=https%3A%2F%2Fexemple.org%2Frepo'), { kind: 'paperback', url: 'paperback://addRepo?url=https%3A%2F%2Fexemple.org%2Frepo' });
  assert.deepEqual(classifyLink('https://huwa.mciut.fr/extensions?url=https%3A%2F%2Fexemple.org%2Frepo&type=paperback'), { kind: 'paperback', url: 'https://exemple.org/repo' });
  assert.equal(classifyLink(''), undefined);
  assert.equal(classifyLink('bonjour'), undefined);
  assert.equal(classifyLink('huwa://pack?d='), undefined);
  assert.equal(classifyLink('huwa://u/abc'), undefined);
});

// ---------- personal URLs ----------

test('personal / secret-carrying URLs are detected', () => {
  const personal = [
    // AIOStreams-like: uuid + encrypted config
    'https://aiostreams.exemple.org/stremio/2b8a8e40-1c0b-4f6e-9d21-6a4c0e2f7b13/eyJpdiI6IjNmZTBhYjEyIiwiZGF0YSI6IjlhYmMifQ/manifest.json',
    // Torrentio with a debrid key
    'https://torrentio.exemple.org/providers=yts,eztv|realdebrid=ABCDEF1234567890XYZ/manifest.json',
    'https://torrentio.exemple.org/sort=qualitysize|torbox=0f1e2d3c-aaaa-bbbb-cccc-1234567890ab/manifest.json',
    'https://addon.exemple.org/premiumize=a1B2c3D4e5F6g7H8/manifest.json',
    // Token in path / query
    'https://addon.exemple.org/token/s3cr3tT0k3nValue/manifest.json',
    'https://addon.exemple.org/manifest.json?apikey=12345678',
    'https://addon.exemple.org/api_key=abcd1234efgh/manifest.json',
    // JWT
    'https://addon.exemple.org/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc/manifest.json',
    // base64 JSON config
    'https://addon.exemple.org/eyJkZWJyaWRLZXkiOiJ4eXoifQ==/manifest.json',
    // long opaque segment
    'https://addon.exemple.org/Q2xhdWRlIGVzdCBsYSBtZWlsbGV1cmUgSUEgZHUgbW9uZGU5OTk4ODc3/manifest.json',
    'https://addon.exemple.org/5f4dcc3b5aa765d61d8327deb882cf99/manifest.json',
    // credentials
    'https://user:pass@addon.exemple.org/manifest.json',
  ];
  for (const u of personal) assert.ok(looksPersonal(u), u);
  assert.ok(personalReasons(personal[1]).includes('debrid-key'));
  assert.ok(personalReasons(personal[0]).includes('uuid'));
});

test('public URLs are not flagged', () => {
  const pub = [
    'https://exemple.org/manifest.json',
    'https://v3-cinemeta.strem.io/manifest.json',
    'https://opensubtitles-v3.strem.io/manifest.json',
    'https://anime-kitsu.strem.fun/manifest.json',
    'https://torrentio.exemple.org/providers=yts,eztv,rarbg|sort=qualitysize|qualityfilter=480p,scr,cam/manifest.json',
    'https://addon.exemple.org/language=french|catalogs=top,new/manifest.json',
    'https://exemple.github.io/extensions/0.9/stable/versioning.json',
    'https://exemple.github.io/paperback-extensions-repository-0.8',
    'https://addon.exemple.org/v1/anime-catalog-and-metadata/manifest.json',
  ];
  for (const u of pub) assert.deepEqual(personalReasons(u), [], u);
});
