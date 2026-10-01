/// <reference types="node" />
// Home sections of a source (Paperback "Discover" / 0.8 home page), through the real sandbox
// bundle with two tiny local fake extensions. Offline: no request leaves the test.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { HttpResponse } from '../runtime/protocol';
import { normalizeSectionItems, normalizeSections } from '../validate';
import { createNodeSandbox } from './harness';

const BUNDLE_09 = `var source=(function(e){
  class Fake {
    async initialise(){}
    async getMangaDetails(id){ return { mangaId: id, mangaInfo: { primaryTitle: 'x', secondaryTitles: [], thumbnailUrl: '', synopsis: '', contentRating: 'SAFE', status: 'ONGOING' } } }
    async getChapters(){ return [] }
    async getChapterDetails(){ return { pages: [] } }
    async getSearchResults(){ return { items: [] } }
    async getDiscoverSections(){ return [
      { id: 'featured', title: 'Featured', type: 0 },
      { id: 'latest', title: 'Latest &amp; Updates', type: 3 },
      { id: 'genres', title: 'Genres', type: 4 },
    ] }
    async getDiscoverSectionItems(section, metadata){
      const page = metadata?.page ?? 1;
      if (section.id === 'featured') return { items: [
        { type: 'featuredCarouselItem', mangaId: 'a', title: 'Solo Leveling', supertitle: '9.1', imageUrl: 'https://img.fake.test/a.jpg' },
        { type: 'featuredCarouselItem', mangaId: 'a', title: 'dup' },
        { type: 'featuredCarouselItem', title: 'no id' },
      ], metadata: page < 2 ? { page: page + 1 } : undefined };
      if (section.id === 'latest') return { items: [{ type: 'chapterUpdatesCarouselItem', mangaId: 'b', chapterId: 'b-20', title: 'Tower', subtitle: 'Ch. 20', imageUrl: 'javascript:alert(1)' }] };
      return { items: [{ type: 'genresCarouselItem', name: 'Action', searchQuery: { title: '' } }] };
    }
  }
  return e.Fake = new Fake(), e;
})({});`;

const BUNDLE_08 = `var _Sources = (() => {
  class Fake {
    constructor(){ }
    async getMangaDetails(id){ return { id, mangaInfo: { titles: ['x'] } } }
    async getChapters(){ return [] }
    async getChapterDetails(){ return { pages: [] } }
    async getSearchResults(){ return App.createPagedResults({ results: [] }) }
    async getHomePageSections(cb){
      const popular = App.createHomeSection({ id: 'popular', title: 'Popular', type: 'singleRowLarge', containsMoreItems: true });
      const fresh = App.createHomeSection({ id: 'new', title: 'New', containsMoreItems: false });
      cb(popular); cb(fresh);
      popular.items = [App.createPartialSourceManga({ mangaId: 'p1', title: 'Popular One', image: 'https://img.fake.test/p1.png', subtitle: 'Ch. 12' })];
      cb(popular);
      fresh.items = [];
      cb(fresh);
    }
    async getViewMoreItems(id, metadata){
      const page = metadata?.page ?? 1;
      return App.createPagedResults({ results: [App.createPartialSourceManga({ mangaId: id + page, title: 'More ' + page })], metadata: page < 3 ? { page: page + 1 } : undefined });
    }
  }
  return { Fake };
})();
this.Sources = _Sources;`;

const offline = (): Promise<HttpResponse> => Promise.reject(new Error('offline'));

test('0.9 discover sections and paged items', async () => {
  const sb = await createNodeSandbox(offline);
  await sb.load('Fake', '0.9', BUNDLE_09);
  const sections = normalizeSections('0.9', await sb.call('discover'));
  assert.deepEqual(sections.map((s) => [s.id, s.kind]), [['featured', 'featured'], ['latest', 'updates'], ['genres', 'genres']]);
  assert.equal(sections[1].title, 'Latest & Updates');
  assert.ok(sections[0].raw, 'section kept to hand back');

  const first = normalizeSectionItems('0.9', await sb.call('discoverItems', sections[0].raw, null));
  assert.deepEqual(first.items, [{ mangaId: 'a', title: 'Solo Leveling', subtitle: '9.1', image: 'https://img.fake.test/a.jpg' }], 'duplicates and id-less items dropped');
  assert.deepEqual(first.next, { page: 2 });
  const second = normalizeSectionItems('0.9', await sb.call('discoverItems', sections[0].raw, first.next));
  assert.equal(second.next, undefined);

  const latest = normalizeSectionItems('0.9', await sb.call('discoverItems', sections[1].raw, null));
  assert.equal(latest.items[0].chapterId, 'b-20');
  assert.equal(latest.items[0].image, undefined, 'non-http image dropped');
  const genres = normalizeSectionItems('0.9', await sb.call('discoverItems', sections[2].raw, null));
  assert.equal(genres.items.length, 0, 'genre tiles are not manga');
});

test('0.8 home page sections (callback, filled later) and view more', async () => {
  const sb = await createNodeSandbox(offline);
  await sb.load('Fake', '0.8', BUNDLE_08);
  const sections = normalizeSections('0.8', await sb.call('discover'));
  assert.deepEqual(sections.map((s) => s.id), ['popular', 'new'], 'order of first callback kept');
  assert.equal(sections[0].kind, 'large');
  assert.equal(sections[0].more, true);
  assert.equal(sections[1].more, false);
  assert.deepEqual(sections[0].items, [{ mangaId: 'p1', title: 'Popular One', subtitle: 'Ch. 12', image: 'https://img.fake.test/p1.png' }]);

  const p1 = normalizeSectionItems('0.8', await sb.call('discoverItems', 'popular', null));
  assert.deepEqual(p1.items.map((i) => i.title), ['More 1']);
  const p2 = normalizeSectionItems('0.8', await sb.call('discoverItems', 'popular', p1.next));
  assert.deepEqual(p2.items.map((i) => i.mangaId), ['popular2']);
});

test('sources without a home page return no section', async () => {
  const sb = await createNodeSandbox(offline);
  await sb.load('Fake', '0.8', BUNDLE_08.replace(/async getHomePageSections[\s\S]*?\n    }\n    async getViewMoreItems/, 'async getViewMoreItems'));
  assert.deepEqual(normalizeSections('0.8', await sb.call('discover')), []);
  assert.throws(() => normalizeSections('0.9', 'nope'), /Sections invalides/);
});
