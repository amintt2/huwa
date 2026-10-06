/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  anchorLabel,
  commentAnchor,
  coversPage,
  findPageTokens,
  findTimeTokens,
  fmtTime,
  isLive,
  isValidRange,
  parseTime,
  withAnchor,
} from '../anchors';
import { numericParam, pageOrRoute, readPath, registerPageTarget, registerSeekTarget, seekOrRoute, watchPath } from '../anchor-nav';

test('parseTime / fmtTime: mm:ss and h:mm:ss, strict bounds', () => {
  assert.equal(parseTime('12:47'), 767);
  assert.equal(parseTime('0:05'), 5);
  assert.equal(parseTime('1:02:03'), 3723);
  assert.equal(parseTime('95:00'), 5700);
  assert.equal(parseTime('12:60'), undefined);
  assert.equal(parseTime('1:60:00'), undefined);
  assert.equal(parseTime('180:00'), undefined);
  assert.equal(parseTime('12:4'), undefined);
  assert.equal(parseTime('abc'), undefined);
  assert.equal(fmtTime(767), '12:47');
  assert.equal(fmtTime(3723), '1:02:03');
  assert.equal(fmtTime(-3), '0:00');
  for (const t of [0, 59, 767, 3599, 3723]) assert.equal(parseTime(fmtTime(t)), t);
});

test('time tokens: moments, ranges with any dash, boundaries', () => {
  const at = (s: string) => findTimeTokens(s).map((t) => ({ s: s.slice(t.index, t.index + t.length), a: t.anchor }));
  assert.deepEqual(at('à 12:47 il pleut'), [{ s: '12:47', a: { type: 'time', start: 767 } }]);
  assert.deepEqual(at('12:47-13:05'), [{ s: '12:47-13:05', a: { type: 'time', start: 767, end: 785 } }]);
  assert.deepEqual(at('de 12:47 – 13:05 !'), [{ s: '12:47 – 13:05', a: { type: 'time', start: 767, end: 785 } }]);
  assert.deepEqual(at('12:47→13:05')[0].a, { type: 'time', start: 767, end: 785 });
  assert.deepEqual(at('1:02:03 à 1:02:30')[0].a, { type: 'time', start: 3723, end: 3750 });
  // Backwards or too long range: two separate moments.
  assert.deepEqual(at('13:05-12:47').map((x) => x.a), [{ type: 'time', start: 785 }, { type: 'time', start: 767 }]);
  assert.deepEqual(at('1:00-59:00').map((x) => x.s), ['1:00', '59:00']);
  // Not times: inside words, ratios, version numbers, ids.
  assert.deepEqual(at('v12:47b'), []);
  assert.deepEqual(at('ratio 16:9'), []);
  assert.deepEqual(at('12:4767'), []);
  assert.deepEqual(at('a12:47'), []);
  assert.equal(isValidRange(10, 10), false);
  assert.equal(isValidRange(10, 10 + 30 * 60), true);
  assert.equal(isValidRange(10, 11 + 30 * 60), false);
});

test('page tokens: p., pp., page(s), ranges', () => {
  const at = (s: string) => findPageTokens(s).map((t) => ({ s: s.slice(t.index, t.index + t.length), a: t.anchor }));
  assert.deepEqual(at('regarde p. 12'), [{ s: 'p. 12', a: { type: 'page', from: 12 } }]);
  assert.deepEqual(at('p.12–14 wow'), [{ s: 'p.12–14', a: { type: 'page', from: 12, to: 14 } }]);
  assert.deepEqual(at('pages 3 à 5')[0].a, { type: 'page', from: 3, to: 5 });
  assert.deepEqual(at('Page 7')[0].a, { type: 'page', from: 7 });
  assert.deepEqual(at('p. 14-12').map((x) => x.s), ['p. 14']);
  assert.deepEqual(at('p. 1-90').map((x) => x.s), ['p. 1']);
  assert.deepEqual(at('top. 3'), []);
  assert.deepEqual(at('p. 0'), []);
  assert.ok(coversPage({ type: 'page', from: 12, to: 14 }, 13));
  assert.ok(!coversPage({ type: 'page', from: 12 }, 13));
});

test('commentAnchor: timestamp field, leading range token, pages, untouched text', () => {
  assert.deepEqual(commentAnchor({ target: 'ep:x', text: 'wow', timestamp: 767.6 }), { anchor: { type: 'time', start: 767 }, body: 'wow' });
  assert.deepEqual(commentAnchor({ target: 'ep:x', text: '12:47–13:05 la pluie', timestamp: 767 }), {
    anchor: { type: 'time', start: 767, end: 785 },
    body: 'la pluie',
  });
  // A range that does not start at the stored moment stays in the text.
  assert.deepEqual(commentAnchor({ target: 'ep:x', text: '1:00–1:30 hop', timestamp: 767 }), { anchor: { type: 'time', start: 767 }, body: '1:00–1:30 hop' });
  // No field: a leading token still anchors (and is removed from the body).
  assert.deepEqual(commentAnchor({ target: 'ep:x', text: '3:12 — l’ouverture' }), { anchor: { type: 'time', start: 192 }, body: 'l’ouverture' });
  assert.deepEqual(commentAnchor({ target: 'ep:x', text: 'à 3:12 l’ouverture' }), { body: 'à 3:12 l’ouverture' });
  assert.deepEqual(commentAnchor({ target: 'ch:c1', text: 'p. 12–14 la double page' }), { anchor: { type: 'page', from: 12, to: 14 }, body: 'la double page' });
  assert.deepEqual(commentAnchor({ target: 'ch:c1', text: '12:47 pas une page' }), { body: '12:47 pas une page' });
  assert.equal(commentAnchor({ target: 'series:s', text: 'p. 3 hors chapitre' }).anchor, undefined);
});

test('withAnchor round-trips through commentAnchor', () => {
  const cases = [
    { target: 'ep:x', a: { type: 'time', start: 767 } as const },
    { target: 'ep:x', a: { type: 'time', start: 767, end: 785 } as const },
    { target: 'ch:c', a: { type: 'page', from: 12 } as const },
    { target: 'ch:c', a: { type: 'page', from: 12, to: 14 } as const },
  ];
  for (const { target, a } of cases) {
    const sent = withAnchor('  super **scène**  ', a);
    assert.deepEqual(commentAnchor({ target, ...sent }), { anchor: a, body: 'super **scène**' }, anchorLabel(a));
  }
  assert.deepEqual(withAnchor(' hi ', undefined), { text: 'hi' });
  assert.equal(withAnchor('x', { type: 'time', start: 767, end: 785 }).text, '12:47–13:05 x');
});

test('isLive: moments last a few seconds, ranges their whole span', () => {
  assert.ok(isLive({ type: 'time', start: 100 }, 103));
  assert.ok(!isLive({ type: 'time', start: 100 }, 108));
  assert.ok(!isLive({ type: 'time', start: 100 }, 99));
  assert.ok(isLive({ type: 'time', start: 100, end: 160 }, 150));
  assert.ok(!isLive({ type: 'time', start: 100, end: 160 }, 160));
  // A very short range still shows long enough to be read.
  assert.ok(isLive({ type: 'time', start: 100, end: 101 }, 105));
});

test('anchor navigation: in place when mounted, else a route', () => {
  assert.equal(seekOrRoute('void-e12', 767.9), '/watch/void-e12?t=767');
  assert.equal(pageOrRoute('c 1', 12), '/read/c%201?page=12');
  const got: number[] = [];
  const off = registerSeekTarget('void-e12', (t) => got.push(t));
  assert.equal(seekOrRoute('void-e12', 767), true);
  assert.deepEqual(got, [767]);
  off();
  assert.equal(typeof seekOrRoute('void-e12', 1), 'string');
  const offPage = registerPageTarget('c1', (p) => got.push(p));
  assert.equal(pageOrRoute('c1', 3), true);
  offPage();
  assert.deepEqual(got, [767, 3]);
  assert.equal(watchPath('e', -4), '/watch/e?t=0');
  assert.equal(readPath('c', 0), '/read/c?page=1');
  assert.equal(numericParam('767', 86400), 767);
  assert.equal(numericParam(['12'], 9999), 12);
  assert.equal(numericParam('12a', 9999), undefined);
  assert.equal(numericParam('99999', 9999), undefined);
  assert.equal(numericParam(undefined, 9), undefined);
});
