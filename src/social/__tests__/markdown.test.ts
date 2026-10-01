/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasSpoilerSpan, parseInline, parseMarkdown, plainText, safeLink, type Inline } from '../markdown';

const txt = (s: string): Inline => ({ t: 'text', s });

test('inline: bold, italic, strike, code, spoiler, nesting', () => {
  assert.deepEqual(parseInline('a **b** c'), [txt('a '), { t: 'b', c: [txt('b')] }, txt(' c')]);
  assert.deepEqual(parseInline('*i* _j_'), [{ t: 'i', c: [txt('i')] }, txt(' '), { t: 'i', c: [txt('j')] }]);
  assert.deepEqual(parseInline('~~x~~'), [{ t: 's', c: [txt('x')] }]);
  assert.deepEqual(parseInline('`**not bold**`'), [{ t: 'code', s: '**not bold**' }]);
  assert.deepEqual(parseInline('||il meurt||'), [{ t: 'spoiler', c: [txt('il meurt')] }]);
  assert.deepEqual(parseInline('**gras *et italique***'), [{ t: 'b', c: [txt('gras '), { t: 'i', c: [txt('et italique')] }] }]);
  assert.deepEqual(parseInline('||**fort**||'), [{ t: 'spoiler', c: [{ t: 'b', c: [txt('fort')] }] }]);
});

test('inline: no false positives', () => {
  assert.deepEqual(parseInline('snake_case_name'), [txt('snake_case_name')]);
  assert.deepEqual(parseInline('2 * 3 * 4'), [txt('2 * 3 * 4')]);
  assert.deepEqual(parseInline('** pas gras **'), [txt('** pas gras **')]);
  assert.deepEqual(parseInline('un | deux || trois'), [txt('un | deux || trois')]);
  assert.deepEqual(parseInline('\\*\\*litteral\\*\\*'), [txt('**litteral**')]);
  assert.deepEqual(parseInline('`ouvert'), [txt('`ouvert')]);
  // Raw HTML is just text.
  assert.deepEqual(parseInline('<b>x</b><img src=x onerror=alert(1)>'), [txt('<b>x</b><img src=x onerror=alert(1)>')]);
});

test('links: http(s) only, domain shown, credentials and odd schemes refused', () => {
  assert.equal(safeLink('https://www.example.com/a?b=c'), 'example.com');
  assert.equal(safeLink('http://anilist.co'), 'anilist.co');
  assert.equal(safeLink('https://user:pw@evil.com'), undefined);
  assert.equal(safeLink('javascript:alert(1)'), undefined);
  assert.equal(safeLink('https://exa mple.com'), undefined);
  assert.equal(safeLink(`https://e.com/${'a'.repeat(600)}`), undefined);
  assert.deepEqual(parseInline('[la fiche](https://anilist.co/anime/1)'), [
    { t: 'link', href: 'https://anilist.co/anime/1', domain: 'anilist.co', c: [txt('la fiche')] },
  ]);
  // Unsafe target: the label stays, the link goes.
  assert.deepEqual(parseInline('[clique](javascript:alert(1))'), [txt('clique')]);
  assert.deepEqual(parseInline('voir https://example.com/x.'), [
    txt('voir '),
    { t: 'link', href: 'https://example.com/x', domain: 'example.com', c: [txt('example.com')] },
    txt('.'),
  ]);
  // Image syntax is not supported: no image node, only text and a link.
  assert.ok(!JSON.stringify(parseInline('![x](https://e.com/a.png)')).includes('"img"'));
});

test('anchors inline, only when asked', () => {
  assert.deepEqual(parseInline('à 12:47–13:05 !', { times: true }), [
    txt('à '),
    { t: 'anchor', anchor: { type: 'time', start: 767, end: 785 }, s: '12:47–13:05' },
    txt(' !'),
  ]);
  assert.deepEqual(parseInline('à 12:47'), [txt('à 12:47')]);
  assert.deepEqual(parseInline('voir p. 3', { pages: true }), [txt('voir '), { t: 'anchor', anchor: { type: 'page', from: 3 }, s: 'p. 3' }]);
  assert.deepEqual(parseInline('**12:47**', { times: true }), [{ t: 'b', c: [{ t: 'anchor', anchor: { type: 'time', start: 767 }, s: '12:47' }] }]);
});

test('blocks: paragraphs, line breaks, quotes, lists, code fences', () => {
  assert.deepEqual(parseMarkdown('a\nb\n\nc'), [
    { t: 'p', c: [txt('a'), { t: 'br' }, txt('b')] },
    { t: 'p', c: [txt('c')] },
  ]);
  assert.deepEqual(parseMarkdown('> cité\n> **ici**\nsuite'), [
    { t: 'quote', c: [{ t: 'p', c: [txt('cité'), { t: 'br' }, { t: 'b', c: [txt('ici')] }] }] },
    { t: 'p', c: [txt('suite')] },
  ]);
  assert.deepEqual(parseMarkdown('- un\n- *deux*'), [{ t: 'list', ordered: false, start: 1, items: [[txt('un')], [{ t: 'i', c: [txt('deux')] }]] }]);
  assert.deepEqual(parseMarkdown('3. trois\n4. quatre'), [{ t: 'list', ordered: true, start: 3, items: [[txt('trois')], [txt('quatre')]] }]);
  assert.deepEqual(parseMarkdown('```\nconst **x** = 1\n```\napres'), [{ t: 'code', s: 'const **x** = 1' }, { t: 'p', c: [txt('apres')] }]);
  assert.deepEqual(parseMarkdown('```\nouvert'), [{ t: 'code', s: 'ouvert' }]);
  // Deep quotes stop nesting.
  const deep = parseMarkdown('> > > trop');
  assert.equal(deep[0].t, 'quote');
  assert.deepEqual(parseMarkdown('# pas un titre'), [{ t: 'p', c: [txt('# pas un titre')] }]);
});

test('plain text: markers removed, spoilers masked unless asked', () => {
  assert.equal(plainText('**Gras** et ||secret||'), 'Gras et ▒▒▒▒▒');
  assert.equal(plainText('||secret||', { spoilers: true }), 'secret');
  assert.equal(plainText('- a\n- b'), '• a\n• b');
  assert.equal(plainText('[fiche](https://anilist.co/x)'), 'fiche');
  assert.equal(plainText('> dit-il'), '« dit-il');
  assert.ok(hasSpoilerSpan('a ||b|| c'));
  assert.ok(!hasSpoilerSpan('a || b'));
});

test('pathological input stays fast and bounded', () => {
  const evil = '*'.repeat(2000);
  const t0 = Date.now();
  parseMarkdown(evil);
  parseMarkdown('**a'.repeat(600));
  parseMarkdown('||'.repeat(1000));
  parseMarkdown('[a]('.repeat(400));
  parseMarkdown('> '.repeat(900) + 'x');
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  // Nesting depth is capped (no stack blow-up).
  parseMarkdown('**'.repeat(10) + 'x' + '**'.repeat(10));
});
