/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFeed, chapterSpan, indexAt, indexOfPage, keepAround, layoutFeed, locate, type Segment } from '../feed';

const seg = (chapterId: string, n: number): Segment => ({ chapterId, pages: Array.from({ length: n }, (_, i) => `${chapterId}/${i}`), origin: 'placeholder' });

test('feed: dividers at every boundary, stable keys when a chapter is added in front', () => {
  const one = buildFeed([seg('c2', 2)], 'c1', 'c3');
  assert.deepEqual(one.map((i) => i.key), ['d:c1|c2', 'p:c2:0', 'p:c2:1', 'd:c2|c3']);
  const two = buildFeed([seg('c1', 1), seg('c2', 2)], undefined, 'c3');
  assert.deepEqual(two.map((i) => i.key), ['p:c1:0', 'd:c1|c2', 'p:c2:0', 'p:c2:1', 'd:c2|c3']);
  // Last chapter: the trailing divider has nothing after it.
  const last = buildFeed([seg('c9', 1)], 'c8', undefined);
  assert.equal(last.at(-1)?.key, 'd:c9|');
  assert.deepEqual(buildFeed([], 'a', 'b'), []);
});

test('feed: layout, lookup and chapter spans', () => {
  const items = buildFeed([seg('a', 2), seg('b', 2)], undefined, undefined);
  const layout = layoutFeed(items, (it) => (it.kind === 'divider' ? 50 : 100));
  assert.deepEqual(layout.offsets, [0, 100, 200, 250, 350, 450]);
  assert.equal(layout.total, 500);
  assert.equal(indexAt(layout.offsets, 0), 0);
  assert.equal(indexAt(layout.offsets, 249), 2);
  assert.equal(indexAt(layout.offsets, 9999), 5);
  assert.equal(indexOfPage(items, 'b', 1), 4);
  assert.deepEqual(chapterSpan(items, layout, 'b'), { start: 250, end: 450, first: 3, last: 4 });
  assert.equal(chapterSpan(items, layout, 'zz'), undefined);
});

test('feed: locate follows the reading line across chapters', () => {
  const items = buildFeed([seg('a', 2), seg('b', 2)], 'z', undefined);
  // [d z|a 50][a0 100][a1 100][d a|b 50][b0 100][b1 100][d b| 50]
  const layout = layoutFeed(items, (it) => (it.kind === 'divider' ? 50 : 100));
  const vp = 90; // reading line at y + 30
  assert.equal(locate(items, layout, 0, vp)?.chapterId, 'a'); // top divider → chapter it starts
  const inA = locate(items, layout, 170, vp)!;
  assert.equal(inA.chapterId, 'a');
  assert.equal(inA.page, 1);
  assert.ok(Math.abs(inA.offset - 0.2) < 1e-9);
  assert.equal(locate(items, layout, 230, vp)?.chapterId, 'a'); // line 260, on the a|b divider
  const inB = locate(items, layout, 290, vp)!;
  assert.equal(inB.chapterId, 'b');
  assert.equal(inB.page, 0);
  assert.equal(locate(items, layout, 460, vp)?.ratio, 1);
});

test('feed: paged locate uses the page index for the ratio', () => {
  const items = buildFeed([seg('a', 4)], undefined, 'b');
  const layout = layoutFeed(items, () => 300);
  const at = locate(items, layout, 600, 300, true)!;
  assert.equal(at.page, 2);
  assert.equal(at.ratio, 0.75);
  assert.equal(at.offset, 0);
});

test('feed: keeps one chapter on each side of the current one', () => {
  const s = ['a', 'b', 'c', 'd'].map((id) => ({ chapterId: id }));
  assert.deepEqual(keepAround(s, 'c').map((x) => x.chapterId), ['b', 'c', 'd']);
  assert.deepEqual(keepAround(s, 'a').map((x) => x.chapterId), ['a', 'b']);
  const two = s.slice(0, 2);
  assert.equal(keepAround(two, 'a'), two); // unchanged: same array
  assert.deepEqual(keepAround(s, 'nope'), s);
});
