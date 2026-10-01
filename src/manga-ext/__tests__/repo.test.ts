/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { base64ToBytes, bytesToBase64, utf8DecodeStrict, utf8Encode } from '../b64';
import { buildChapters, pickLang, titlesMatch } from '../chapters';
import { bundleUrl, compareVersions, detectFormat, iconUrl, normalizeRepoUrl, parseRepoLink, parseVersioning, sourceKey } from '../repo';

// Shapes copied from real repositories (Paperback toolchain 0.8.7 and 1.0.0-alpha.92 output).
const V08 = {
  buildTime: '2026-01-01T00:00:00.000Z',
  sources: [
    { id: 'MangaDex', name: 'MangaDex', author: 'Netsky', desc: 'Extension that pulls manga from MangaDex', website: 'https://github.com/TheNetsky', contentRating: 'EVERYONE', version: '3.0.6', icon: 'icon.png', tags: [{ text: 'Multi Language', type: 'default' }], websiteBaseURL: 'https://mangadex.org', intents: 53 },
    { id: '../evil', name: 'x', version: '1', contentRating: 'ADULT' },
    { id: 'Adult', name: 'Adult', desc: '', contentRating: 'ADULT', version: '1.0.0', icon: '../../etc/passwd', intents: 1 },
  ],
  builtWith: { toolchain: '0.8.7', types: '0.8.7' },
};
const V09 = {
  buildTime: '2026-09-27T12:08:01.995Z',
  builtWith: { toolchain: '1.0.0-alpha.92', types: '1.0.0-alpha.92' },
  repository: { name: 'Inkdex Extensions (0.9)', description: 'All extensions from the Inkdex community in a single repository.' },
  sources: [
    { id: 'Webtoon', name: 'Webtoon', description: 'Extension that pulls content from webtoons.com.', version: '1.0.0-alpha.18', icon: 'icon.png', language: 'multi', contentRating: 'SAFE', badges: [{ label: 'Official', textColor: '#fff', backgroundColor: '#000' }], capabilities: [1, 4, 64], developers: [{ name: 'Inkdex' }] },
  ],
};

test('repository URLs are normalized', () => {
  assert.equal(normalizeRepoUrl('https://inkdex.github.io/extensions/0.9/stable/'), 'https://inkdex.github.io/extensions/0.9/stable');
  assert.equal(normalizeRepoUrl('https://x.github.io/repo/versioning.json'), 'https://x.github.io/repo');
  assert.equal(normalizeRepoUrl('x.github.io/repo/index.html?y=1'), 'https://x.github.io/repo');
  assert.throws(() => normalizeRepoUrl('file:///etc/passwd'));
  assert.throws(() => normalizeRepoUrl('javascript:alert(1)'));
});

test('Paperback and Huwa repository links', () => {
  const add = parseRepoLink('paperback://addRepo?displayName=Inkdex%20Extensions%20(0.9)&url=https%3A%2F%2Finkdex.github.io%2Fextensions%2F0.9%2Fstable');
  assert.deepEqual(add, { repo: 'https://inkdex.github.io/extensions/0.9/stable', name: 'Inkdex Extensions (0.9)' });
  assert.equal(normalizeRepoUrl('paperback://addRepo?displayName=A&url=https%3A%2F%2Fa.io%2Fr%2F'), 'https://a.io/r');
  assert.equal(parseRepoLink('huwa://paperback?repo=https%3A%2F%2Fa.io%2Fr')?.repo, 'https://a.io/r');
  const data = bytesToBase64(utf8Encode(JSON.stringify([['Webtoon', 'https://a.io/r'], ['../x', 'https://a.io/r']])));
  const install = parseRepoLink(`paperback://installExtensions?data=${data}`);
  assert.deepEqual(install?.install, [{ id: 'Webtoon', repo: 'https://a.io/r' }]);
  assert.equal(parseRepoLink('https://a.io/r'), undefined);
});

test('format detection: 0.8 vs 0.9, older formats refused', () => {
  assert.equal(detectFormat(V08), '0.8');
  assert.equal(detectFormat(V09), '0.9');
  assert.equal(detectFormat({ sources: [{ id: 'A', intents: 1 }] }), '0.8');
  assert.equal(detectFormat({ sources: [{ id: 'A', capabilities: [1] }] }), '0.9');
  assert.throws(() => detectFormat({ builtWith: { types: '5.0.0' }, sources: [] }), /trop ancien/);
});

test('versioning.json 0.8 is parsed and sanitized', () => {
  const r = parseVersioning(V08, 'https://thenetsky.github.io/community-extensions/0.8/');
  assert.equal(r.format, '0.8');
  assert.equal(r.url, 'https://thenetsky.github.io/community-extensions/0.8');
  assert.deepEqual(r.sources.map((s) => s.id), ['MangaDex', 'Adult']);
  const md = r.sources[0];
  assert.equal(md.author, 'Netsky');
  assert.deepEqual(md.tags, ['Multi Language']);
  assert.equal(md.website, 'https://mangadex.org');
  assert.equal(r.sources[1].icon, undefined, 'path traversal in icon refused');
  assert.equal(r.sources[1].contentRating, 'ADULT');
  assert.equal(bundleUrl(r.url, r.format, 'MangaDex'), 'https://thenetsky.github.io/community-extensions/0.8/MangaDex/source.js');
  assert.equal(iconUrl(r.url, r.format, 'MangaDex', 'icon.png'), 'https://thenetsky.github.io/community-extensions/0.8/MangaDex/includes/icon.png');
});

test('versioning.json 0.9 is parsed', () => {
  const r = parseVersioning(V09, 'https://inkdex.github.io/extensions/0.9/stable');
  assert.equal(r.format, '0.9');
  assert.equal(r.name, 'Inkdex Extensions (0.9)');
  const w = r.sources[0];
  assert.equal(w.contentRating, 'EVERYONE');
  assert.equal(w.author, 'Inkdex');
  assert.deepEqual(w.tags, ['Official']);
  assert.equal(bundleUrl(r.url, r.format, 'Webtoon'), 'https://inkdex.github.io/extensions/0.9/stable/Webtoon/index.js');
  assert.equal(iconUrl(r.url, r.format, 'Webtoon', 'icon.png'), 'https://inkdex.github.io/extensions/0.9/stable/Webtoon/static/icon.png');
  assert.match(sourceKey(r.url, 'Webtoon'), /^[a-z0-9]+\.Webtoon$/);
  assert.throws(() => parseVersioning({ nope: 1 }, r.url));
});

test('version comparison handles alpha tags', () => {
  assert.ok(compareVersions('1.0.0-alpha.28', '1.0.0-alpha.27') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-alpha.99') > 0);
  assert.ok(compareVersions('3.0.6', '3.1.0') < 0);
  assert.equal(compareVersions('2.0', '2.0.0'), 0);
});

test('base64 and strict UTF-8', () => {
  const bytes = utf8Encode('héllo 🇬🇧');
  assert.equal(bytesToBase64(bytes), Buffer.from('héllo 🇬🇧').toString('base64'));
  assert.equal(utf8DecodeStrict(base64ToBytes(bytesToBase64(bytes))), 'héllo 🇬🇧');
  assert.equal(utf8DecodeStrict(new Uint8Array([0xff, 0xfe])), undefined);
  assert.throws(() => base64ToBytes('@@@'));
});

test('chapters: language choice, one per number, stable ids', () => {
  const ch = (chapterId: string, number: number, lang: string) => ({ chapterId, number, lang });
  const all = [ch('a', 2, 'en'), ch('b', 1, 'en'), ch('c', 1, 'en'), ch('d', 1.5, 'fr'), ch('e', NaN, 'en'), ch('f', 3, 'es')];
  assert.equal(pickLang(all), 'fr');
  assert.equal(pickLang(all, 'es'), 'es');
  assert.equal(pickLang(all.filter((c) => c.lang !== 'fr'), undefined, 'fr'), 'en');
  const list = buildChapters('al42', all, 'en');
  assert.deepEqual(list.map((c) => c.id), ['al42-c1', 'al42-c2', `al42-cx${list[2].id.slice(7)}`]);
  assert.equal(list[0].chapterId, 'b', 'first group wins for a duplicated number');
  assert.equal(list[2].number, 3, 'unnumbered chapters go after the last one');
  assert.equal(buildChapters('px1', all, 'fr')[0].id, 'px1-c1.5');
});

test('chapters restarting their numbering each volume are all kept', () => {
  const ch = (chapterId: string, volume: number | undefined, number: number) => ({ chapterId, lang: 'en', number, volume });
  const all = [ch('v2c1', 2, 1), ch('v1c1', 1, 1), ch('v1c2', 1, 2), ch('v2c2', 2, 2), ch('v1c1-other-group', 1, 1), ch('nov', undefined, 1)];
  const list = buildChapters('al7', all, 'en');
  assert.deepEqual(list.map((c) => c.chapterId), ['v1c1', 'v1c2', 'v2c1', 'v2c2']);
  assert.deepEqual(list.map((c) => c.id), ['al7-c1', 'al7-c2', 'al7-v2-c1', 'al7-v2-c2']);
  assert.equal(new Set(list.map((c) => c.id)).size, list.length);
  assert.equal(list[2].title, 'Vol. 2');
  // Continuous numbering across volumes: unchanged ids, no volume in the title.
  const flat = buildChapters('al8', [ch('a', 1, 1), ch('b', 1, 2), ch('c', 2, 3)], 'en');
  assert.deepEqual(flat.map((c) => [c.id, c.title]), [['al8-c1', undefined], ['al8-c2', undefined], ['al8-c3', undefined]]);
});

test('AniList title matching', () => {
  const media = { title: { english: 'Kaguya-sama: Love Is War', romaji: 'Kaguya-sama wa Kokurasetai', userPreferred: 'Kaguya-sama wa Kokurasetai', native: null }, synonyms: ['Kaguya Wants to be Confessed To'] };
  assert.ok(titlesMatch(['Kaguya-sama: Love is War  '], media));
  assert.ok(titlesMatch(['Nope', 'Kaguya Wants To Be Confessed To'], media));
  assert.ok(!titlesMatch(['Kaguya'], media));
  assert.ok(!titlesMatch(['A'], { title: { english: 'A' } }), 'too short to be meaningful');
});
