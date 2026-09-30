/// <reference types="node" />
// Runs the real sandbox bundle (same esbuild output as the app) with two synthetic extensions
// written in the exact shape the Paperback toolchains emit (0.8: esbuild IIFE + `this.Sources`,
// 0.9: rolldown IIFE `var source = …` with an instance export). Offline: the host is faked.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bytesToBase64, utf8DecodeStrict, base64ToBytes, utf8Encode } from '../b64';
import { frameHtml, hostHtml } from '../host-page';
import type { HttpRequest, HttpResponse } from '../runtime/protocol';
import { md5 } from '../runtime/md5';
import { normalizeChapters, normalizeDetails, normalizeImageHeaders, normalizePages, normalizeSearch } from '../validate';
import { createNodeSandbox } from './harness';

const BUNDLE_09 = `var source=(function(e){
  class CloudflareError extends Error { constructor(m){ super(m); this.name='CloudflareError' } }
  class Demo {
    async initialise(){
      Application.registerInterceptor('main', Application.Selector(this,'interceptRequest'), Application.Selector(this,'interceptResponse'));
      Application.setState(Application.getState('boots') ? Application.getState('boots') + 1 : 1, 'boots');
    }
    async interceptRequest(r){ r.headers = { ...(r.headers ?? {}), referer: 'https://demo.test/', 'user-agent': await Application.getDefaultUserAgent() }; r.cookies = { ...(r.cookies ?? {}), age: 'ok' }; return r }
    async interceptResponse(req, res, data){ return res.status === 200 ? data : data }
    async getMangaDetails(id){
      if (id === 'cf') throw new CloudflareError('blocked');
      const [res, buf] = await Application.scheduleRequest({ url: 'https://demo.test/manga/' + id, method: 'GET' });
      const j = JSON.parse(Application.arrayBufferToUTF8String(buf));
      return { mangaId: id, mangaInfo: { primaryTitle: j.title, secondaryTitles: [], thumbnailUrl: j.cover, synopsis: Application.decodeHTMLEntities('A &amp; B ' + res.status), contentRating: 'SAFE', status: 'ONGOING', additionalInfo: { md5: Application.crypto_md5Hash('abc') } } };
    }
    async getChapters(sm){ return [{ chapterId: 'c1', sourceManga: sm, chapNum: 1, langCode: '\\u{1F1EC}\\u{1F1E7}', publishDate: new Date('2024-01-01T00:00:00Z') }] }
    async getChapterDetails(ch){
      if (!(ch.publishDate instanceof Date)) throw new Error('date not revived');
      return { id: ch.chapterId, mangaId: ch.sourceManga.mangaId, pages: ['https://img.demo.test/1.jpg', 'https://img.demo.test/2.jpg'] };
    }
    async getSortingOptions(){ return [{ id: 'pop', label: 'Popular' }] }
    async getSearchResults(q, meta, sort){ return { items: [{ mangaId: 'm1', title: q.title + ':' + (sort ? sort.id : 'none') + ':' + typeof fetch, imageUrl: 'https://img/x.jpg' }], metadata: { page: 2 } } }
  }
  return e.Demo = new Demo(), e.DemoExtension = Demo, e;
})({});`;

const BUNDLE_08 = `var _Sources = (() => {
  const DemoInfo = { version: '1.0.0', name: 'Demo', icon: 'icon.png', author: 'x', description: 'd', contentRating: 'EVERYONE', websiteBaseURL: 'https://demo.test' };
  class Demo {
    constructor(cheerio){
      this.cheerio = cheerio;
      this.stateManager = App.createSourceStateManager();
      this.requestManager = App.createRequestManager({ requestsPerSecond: 3, requestTimeout: 15000, interceptor: {
        interceptRequest: async (r) => { r.headers = { ...(r.headers ?? {}), referer: 'https://demo.test/' }; return r },
        interceptResponse: async (r) => r } });
    }
    async getMangaDetails(mangaId){
      const res = await this.requestManager.schedule(App.createRequest({ url: 'https://demo.test/html/', param: mangaId, method: 'GET' }), 1);
      const $ = this.cheerio.load(res.data);
      await this.stateManager.store('last', mangaId);
      return App.createSourceManga({ id: mangaId, mangaInfo: App.createMangaInfo({ titles: [$('h1').text().trim()], image: $('img').attr('src'), desc: $('p').text(), status: 'Completed', hentai: false,
        tags: [App.createTagSection({ id: 'g', label: 'Genres', tags: [App.createTag({ id: 'a', label: 'Action' })] })] }) });
    }
    async getChapters(mangaId){ return [App.createChapter({ id: 'c1', chapNum: 1, langCode: 'fr', time: new Date('2024-02-01T00:00:00Z') })] }
    async getChapterDetails(mangaId, chapterId){ return App.createChapterDetails({ id: chapterId, mangaId, pages: ['https://img.demo.test/p1.png'] }) }
    async getSearchResults(query, metadata){
      const res = await this.requestManager.schedule(App.createRequest({ url: 'https://demo.test/search', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: { q: query.title, n: 1 } }), 0);
      return App.createPagedResults({ results: [App.createPartialSourceManga({ mangaId: 'm1', title: res.data, image: 'https://img/1.jpg' })] });
    }
  }
  return { Demo, DemoInfo };
})();
this.Sources = _Sources; if (typeof exports === 'object' && typeof module !== 'undefined') {module.exports.Sources = this.Sources;}`;

function fakeSite(req: HttpRequest): Promise<HttpResponse> {
  const ok = (body: string, type = 'text/html') => Promise.resolve({ url: req.url, status: 200, headers: { 'content-type': type }, cookies: [], mimeType: type, body64: bytesToBase64(utf8Encode(body)) });
  if (req.url.startsWith('https://demo.test/manga/')) return ok(JSON.stringify({ title: 'Démo', cover: 'https://img.demo.test/c.jpg' }), 'application/json');
  if (req.url === 'https://demo.test/html/m1') return ok('<html><h1> Titre &amp; co </h1><img src="https://img.demo.test/c.jpg"><p>Résumé</p></html>');
  if (req.url === 'https://demo.test/search') return ok(`echo:${req.method}:${utf8DecodeStrict(base64ToBytes(req.body64 ?? ''))}`);
  return Promise.reject(new Error(`unexpected ${req.url}`));
}

test('Paperback 0.9 extension: Application.*, interceptors, state, selectors', async () => {
  const sb = await createNodeSandbox(fakeSite);
  await sb.load('Demo', '0.9', BUNDLE_09, { boots: 4 });
  assert.equal(sb.state.boots, 5, 'state preloaded (sync getState) and written back');

  const details = normalizeDetails('0.9', await sb.call('details', 'm1'), 'm1');
  assert.equal(details.title, 'Démo');
  assert.equal(details.synopsis, 'A & B 200');
  assert.equal((details.sourceManga as { mangaInfo: { additionalInfo: { md5: string } } }).mangaInfo.additionalInfo.md5, '900150983cd24fb0d6963f7d28e17f72');
  const req = sb.requests[0];
  assert.equal(req.headers.referer, 'https://demo.test/');
  assert.equal(req.headers.Cookie, 'age=ok', 'Request.cookies become a Cookie header');
  assert.equal(req.headers['user-agent'], 'HuwaTest/1.0');

  const chapters = normalizeChapters('0.9', await sb.call('chapters', details.sourceManga));
  assert.equal(chapters[0].lang, 'en');
  assert.equal(chapters[0].raw?.sourceManga, undefined, 'sourceManga stripped from each chapter');
  const pages = normalizePages('0.9', await sb.call('pages', chapters[0].raw, details.sourceManga));
  assert.equal(pages.pages.length, 2);

  const search = normalizeSearch('0.9', await sb.call('search', 'solo', null));
  assert.equal(search.items[0].title, 'solo:pop:undefined', 'first sorting option passed; no fetch global');
  assert.deepEqual(search.next, { page: 2 });

  const headers = normalizeImageHeaders(await sb.call('imageHeaders', pages.pages[0]));
  assert.equal(headers?.referer, 'https://demo.test/');
  assert.equal(headers?.Cookie, 'age=ok');

  await assert.rejects(sb.call('details', 'cf'), /cloudflare/i);
});

test('Paperback 0.8 extension: App.*, RequestManager, cheerio, state manager', async () => {
  const sb = await createNodeSandbox(fakeSite);
  await sb.load('Demo', '0.8', BUNDLE_08);
  const details = normalizeDetails('0.8', await sb.call('details', 'm1'), 'm1');
  assert.equal(details.title, 'Titre & co');
  assert.equal(details.image, 'https://img.demo.test/c.jpg');
  assert.equal(details.synopsis, 'Résumé');
  assert.deepEqual(details.tags, ['Action']);
  assert.equal(sb.state.last, 'm1');
  assert.equal(sb.requests[0].url, 'https://demo.test/html/m1', 'param appended to url');
  assert.equal(sb.requests[0].headers.referer, 'https://demo.test/');
  assert.equal(sb.requests[0].rps, 3);

  const chapters = normalizeChapters('0.8', await sb.call('chapters', 'm1'));
  assert.equal(chapters[0].date, Date.parse('2024-02-01T00:00:00Z'));
  assert.deepEqual(normalizePages('0.8', await sb.call('pages', 'm1', 'c1')).pages, ['https://img.demo.test/p1.png']);

  const search = normalizeSearch('0.8', await sb.call('search', 'a b', null));
  assert.equal(search.items[0].title, 'echo:POST:q=a%20b&n=1', 'form body url-encoded');
  assert.equal(normalizeImageHeaders(await sb.call('imageHeaders', 'https://img.demo.test/p1.png'))?.referer, 'https://demo.test/');
});

test('broken bundles are reported, not fatal', async () => {
  const sb = await createNodeSandbox(fakeSite);
  await assert.rejects(sb.load('Nope', '0.9', 'var source = {}'), /introuvable/);
  const sb2 = await createNodeSandbox(fakeSite);
  await assert.rejects(sb2.load('X', '0.8', 'this.Sources = {'), /./);
});

test('md5', () => {
  assert.equal(md5(new Uint8Array()), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5(utf8Encode('The quick brown fox jumps over the lazy dog')), '9e107d9d372bb6826bd81d3542a419d6');
  assert.equal(md5(new Uint8Array(1000).fill(97)), 'cabe45dcc9ae5b66ba86600cca6b8ba8');
});

test('host page isolates each source in a sandboxed iframe with a strict CSP', () => {
  const frame = frameHtml('var x = "</script><script>alert(1)</script>";');
  assert.ok(!frame.includes('"</script><script>alert(1)'), 'inline runtime cannot close its script tag');
  assert.match(frame, /default-src 'none'/);
  const page = hostHtml('1');
  assert.match(page, /setAttribute\('sandbox','allow-scripts'\)/);
  assert.ok(!/allow-same-origin/.test(page));
  assert.match(page, /e\.source/);
});
