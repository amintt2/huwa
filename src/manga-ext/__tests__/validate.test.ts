/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CookieJar, checkUrl, cleanHeaders, createNet, escapeUrl, parseHttpUrl, splitSetCookie, type RawFetch } from '../net';
import { httpUrl, mapStatus, normalizeChapters, normalizeDetails, normalizeImageHeaders, normalizeLang, normalizePages, normalizeSearch } from '../validate';

test('details 0.8 (App.createSourceManga) and 0.9 (SourceManga)', () => {
  const d8 = normalizeDetails('0.8', {
    id: 'x',
    mangaInfo: { image: 'https://cdn/x.jpg', desc: 'A &amp; B<br>C', status: 'Completed', titles: ['Main', 'Alt', 'Main'], author: 'Au', hentai: false, rating: 87, tags: [{ id: 'g', label: 'Genres', tags: [{ id: '1', label: 'Action' }] }] },
  }, 'x');
  assert.equal(d8.title, 'Main');
  assert.deepEqual(d8.altTitles, ['Alt']);
  assert.equal(d8.synopsis, 'A & B\nC');
  assert.equal(d8.status, 'completed');
  assert.equal(d8.rating, 8.7);
  assert.deepEqual(d8.tags, ['Action']);
  assert.equal(d8.sourceManga, undefined);

  const d9 = normalizeDetails('0.9', {
    mangaId: 'y',
    mangaInfo: { thumbnailUrl: 'javascript:alert(1)', synopsis: 's', primaryTitle: 'Solo‍  ', secondaryTitles: ['B'], contentRating: 'ADULT', status: 'ONGOING', tagGroups: [{ id: 't', title: 'Tags', tags: [{ id: 'a', title: 'Drama' }] }], additionalInfo: { k: 'v' } },
  }, 'y');
  assert.equal(d9.title, 'Solo');
  assert.equal(d9.image, undefined, 'non-http image dropped');
  assert.equal(d9.adult, true);
  assert.deepEqual(d9.tags, ['Drama']);
  assert.deepEqual((d9.sourceManga as { mangaInfo: { additionalInfo: unknown } }).mangaInfo.additionalInfo, { k: 'v' });
  assert.throws(() => normalizeDetails('0.9', { mangaId: 'y', mangaInfo: { primaryTitle: '' } }, 'y'));
  assert.throws(() => normalizeDetails('0.9', { mangaId: 'y', mangaInfo: { primaryTitle: 'x', blob: 'a'.repeat(70_000) } }, 'y'));
});

test('chapters 0.8 / 0.9', () => {
  const c8 = normalizeChapters('0.8', [
    { id: 'c1', chapNum: 1, langCode: 'EN', name: 'One', time: '2024-01-02T00:00:00Z', group: 'G' },
    { id: 'c1', chapNum: 1 },
    { id: '', chapNum: 2 },
    'junk',
  ]);
  assert.equal(c8.length, 1);
  assert.equal(c8[0].lang, 'en');
  assert.equal(c8[0].date, Date.parse('2024-01-02T00:00:00Z'));
  const c9 = normalizeChapters('0.9', [{ chapterId: 'k', chapNum: '12.5', langCode: '🇬🇧', title: 'T', sourceManga: { huge: 1 }, additionalInfo: { a: '1' } }]);
  assert.equal(c9[0].number, 12.5);
  assert.equal(c9[0].lang, 'en');
  assert.deepEqual(c9[0].raw, { chapterId: 'k', chapNum: '12.5', langCode: '🇬🇧', title: 'T', additionalInfo: { a: '1' } });
  assert.throws(() => normalizeChapters('0.9', { not: 'array' }));
});

test('pages: http(s) only, novels refused', () => {
  assert.deepEqual(normalizePages('0.8', { id: 'c', mangaId: 'm', pages: ['https://a/1.jpg', 'data:image/png;base64,xx', 'http://127.0.0.1/x', 'https://a/2 b.jpg'] }).pages, ['https://a/1.jpg', 'https://a/2%20b.jpg']);
  assert.throws(() => normalizePages('0.9', { id: 'c', mangaId: 'm', type: 'html', html: '<p>' }), /roman/);
  assert.throws(() => normalizePages('0.9', { id: 'c', mangaId: 'm', pages: ['file:///x'] }), /Aucune page/);
});

test('search results 0.8 / 0.9 and 0.6-style tiles', () => {
  const s9 = normalizeSearch('0.9', { items: [{ mangaId: 'a', title: 'A &amp; B', imageUrl: 'https://i/a.jpg' }, { mangaId: 'a', title: 'dup' }], metadata: { page: 2 } });
  assert.deepEqual(s9.items, [{ mangaId: 'a', title: 'A & B', subtitle: undefined, image: 'https://i/a.jpg' }]);
  assert.deepEqual(s9.next, { page: 2 });
  const s8 = normalizeSearch('0.8', { results: [{ mangaId: 'b', title: 'B', image: 'https://i/b.jpg', subtitle: 'Ch. 3' }, { id: 'c', title: { text: 'C' } }] });
  assert.deepEqual(s8.items.map((i) => i.mangaId), ['b', 'c']);
  assert.equal(s8.next, undefined);
});

test('image headers are filtered', () => {
  assert.deepEqual(normalizeImageHeaders({ headers: { referer: 'https://www.webtoons.com/', Cookie: 'a=b', Host: 'evil', 'bad header': 'x', 'x-token': 't', Connection: 'close' } }), {
    referer: 'https://www.webtoons.com/',
    Cookie: 'a=b',
    'x-token': 't',
  });
  assert.equal(normalizeImageHeaders({ headers: {} }), undefined);
});

test('misc normalizers', () => {
  assert.equal(normalizeLang('🇫🇷'), 'fr');
  assert.equal(normalizeLang('pt_BR'), 'pt-br');
  assert.equal(normalizeLang('<script>'), 'unknown');
  assert.equal(mapStatus('Finished'), 'completed');
  assert.equal(mapStatus('ONGOING'), 'ongoing');
  assert.equal(httpUrl('ftp://x'), undefined);
});

test('URL policy', () => {
  assert.equal(parseHttpUrl('https://a.b:8080/x?y#z')?.host, 'a.b');
  assert.equal(parseHttpUrl('https://user:pw@A.B/x')?.host, 'a.b');
  for (const bad of ['http://localhost/x', 'http://127.0.0.1:8080', 'http://[::1]/', 'http://169.254.169.254/latest', 'file:///etc/hosts', 'data:,x']) {
    assert.throws(() => checkUrl(bad), Error, bad);
  }
  assert.doesNotThrow(() => checkUrl('http://192.168.1.10:25600/api')); // self-hosted servers on the LAN
  assert.equal(escapeUrl('https://a.io/search?q=Tower of God|é'), 'https://a.io/search?q=Tower%20of%20God%7C%C3%A9');
  assert.deepEqual(cleanHeaders({ Referer: 'r', 'Content-Length': '1', 'x\r\ny': 'z', A: 'b\r\nInjected: 1' }), { Referer: 'r', A: 'b  Injected: 1' });
});

test('cookie jar: domain, path, expiry, split header', () => {
  const jar = new CookieJar();
  const u = parseHttpUrl('https://www.example.com/a/b')!;
  jar.set(u, 'sid=1; Path=/; Domain=example.com; Secure');
  jar.set(u, 'local=2');
  jar.set(u, 'evil=3; Domain=other.com');
  jar.set(u, 'old=4; Max-Age=-1');
  jar.set(u, 'deep=5; Path=/a/b/c');
  assert.equal(jar.header(parseHttpUrl('https://cdn.example.com/')!), 'sid=1');
  assert.equal(jar.header(parseHttpUrl('http://example.com/')!), '', 'secure cookie not sent over http');
  assert.equal(jar.header(parseHttpUrl('https://www.example.com/x')!), 'sid=1; local=2');
  assert.equal(jar.header(parseHttpUrl('https://www.example.com/a/b/c/d')!), 'sid=1; local=2; deep=5');
  assert.deepEqual(splitSetCookie('a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, b=2'), ['a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/', 'b=2']);
  const restored = new CookieJar(JSON.parse(JSON.stringify(jar)));
  assert.equal(restored.header(parseHttpUrl('https://www.example.com/x')!), 'sid=1; local=2');
});

test('net: per-source jar, UA, size cap, policy before any fetch', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fake: RawFetch = async (url, init) => {
    seen.push({ url, headers: init.headers });
    if (url.includes('big')) return { url, status: 200, headers: {} as Record<string, string>, setCookies: [], body: new Uint8Array(init.maxBytes + 1) };
    return { url, status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'x' }, setCookies: ['s=1; Path=/'], body: new TextEncoder().encode('ok') };
  };
  const jars = new Map<string, CookieJar>();
  const net = createNet(fake, { jar: (k) => jars.get(k) ?? (jars.set(k, new CookieJar()), jars.get(k)!), maxBytes: 1024 });
  const r = await net.request('a', { url: 'https://site.io/p', method: 'get', headers: {} });
  assert.equal(r.status, 200);
  assert.equal(r.mimeType, 'text/html');
  assert.equal(r.headers['set-cookie'], undefined);
  assert.deepEqual(r.cookies.map((c) => c.name), ['s']);
  assert.match(seen[0].headers['User-Agent'], /Mozilla/);
  await net.request('a', { url: 'https://site.io/q', method: 'GET', headers: { Cookie: 'mine=1' } });
  assert.equal(seen[1].headers.Cookie, 's=1; mine=1');
  await net.request('b', { url: 'https://site.io/q', method: 'GET', headers: {} });
  assert.equal(seen[2].headers.Cookie, undefined, 'another source does not see the cookie');
  await assert.rejects(net.request('a', { url: 'https://site.io/big', method: 'GET', headers: {} }), /volumineuse/);
  await assert.rejects(net.request('a', { url: 'http://localhost:8081/', method: 'GET', headers: {} }), /refusé/);
  await assert.rejects(net.request('a', { url: 'https://site.io/', method: 'CONNECT', headers: {} }), /Méthode/);
  assert.equal(seen.length, 4, 'refused requests never reach the transport');
});
