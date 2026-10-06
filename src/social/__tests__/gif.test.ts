/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { attachGif, extractGif, giphyEndpoint, isAllowedGifUrl, normalizeGifLink, parseGiphyResponse } from '../gif';

test('allowlist: https, known GIF CDNs, image paths only', () => {
  for (const ok of [
    'https://media.giphy.com/media/26ufdipQqU2lhNA4g/200.gif',
    'https://media2.giphy.com/media/v1.Y2lk/26ufdipQqU2lhNA4g/giphy.webp',
    'https://i.giphy.com/26ufdipQqU2lhNA4g.gif',
    'https://media.tenor.com/AbCdEf12345AAAAC/anime-wow.gif',
    'https://c.tenor.com/AbCdEf12345AAAAC/tenor.gif',
    'https://static.klipy.com/ii/abc/def/xyz.gif',
  ]) assert.ok(isAllowedGifUrl(ok), ok);
  for (const bad of [
    'http://media.giphy.com/media/x/200.gif', // not https
    'https://giphy.com/gifs/funny-26ufdipQqU2lhNA4g', // page, not a file
    'https://media.giphy.com.evil.com/a.gif',
    'https://evil.com/media.giphy.com/a.gif',
    'https://user@media.giphy.com/a.gif',
    'https://media.giphy.com:444/a.gif',
    'https://media.giphy.com/media/x/200.mp4',
    'https://media.giphy.com/../a.gif',
    'https://media.tenor.com/' + 'a'.repeat(300) + '.gif',
    'javascript:alert(1)//.gif',
  ]) assert.ok(!isAllowedGifUrl(bad), bad);
});

test('normalize pasted links: GIPHY pages, query strings, Tenor pages explained', () => {
  assert.deepEqual(normalizeGifLink('https://giphy.com/gifs/reaction-mind-blown-26ufdipQqU2lhNA4g'), { url: 'https://i.giphy.com/26ufdipQqU2lhNA4g.gif' });
  assert.deepEqual(normalizeGifLink('https://giphy.com/gifs/26ufdipQqU2lhNA4g'), { url: 'https://i.giphy.com/26ufdipQqU2lhNA4g.gif' });
  assert.deepEqual(normalizeGifLink(' https://media3.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif?cid=abc&rid=giphy.gif '), {
    url: 'https://media3.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif',
  });
  assert.ok('error' in normalizeGifLink('https://tenor.com/view/anime-wow-gif-12345'));
  assert.ok('error' in normalizeGifLink('https://example.com/a.gif'));
  assert.ok('error' in normalizeGifLink('pas un lien'));
  assert.ok('error' in normalizeGifLink(''));
});

test('extract / attach: the GIF URL lives in the text', () => {
  const url = 'https://media.giphy.com/media/26ufdipQqU2lhNA4g/200.gif';
  assert.deepEqual(extractGif(`Ma réaction :\n${url}`), { gif: url, text: 'Ma réaction :' });
  assert.deepEqual(extractGif(url), { gif: url, text: '' });
  assert.deepEqual(extractGif(`avant ${url} après`), { gif: url, text: 'avant  après' });
  // Not standalone, or not allowlisted: left alone.
  assert.deepEqual(extractGif(`(${url})`), { text: `(${url})` });
  assert.deepEqual(extractGif('https://example.com/a.gif'), { text: 'https://example.com/a.gif' });
  assert.equal(attachGif(' salut ', url), `salut\n${url}`);
  assert.equal(attachGif('', url), url);
  assert.equal(attachGif('x', undefined), 'x');
  assert.deepEqual(extractGif(attachGif('**wow**', url)), { gif: url, text: '**wow**' });
});

test('GIPHY API: endpoint with pg-13, response filtered to allowlisted, rated GIFs', () => {
  assert.equal(giphyEndpoint('K', ''), 'https://api.giphy.com/v1/gifs/trending?api_key=K&limit=24&rating=pg-13');
  assert.equal(giphyEndpoint('K', ' one piece '), 'https://api.giphy.com/v1/gifs/search?api_key=K&limit=24&rating=pg-13&q=one%20piece&lang=fr');
  const img = (id: string, host = 'media1.giphy.com') => ({
    fixed_height: { url: `https://${host}/media/${id}/200.gif?cid=x`, width: '356', height: '200' },
    fixed_width_downsampled: { url: `https://${host}/media/${id}/200w_d.gif?cid=x` },
  });
  const res = parseGiphyResponse({
    data: [
      { id: 'a', title: 'Wow', rating: 'g', images: img('a') },
      { id: 'b', rating: 'r', images: img('b') },
      { id: 'c', rating: 'pg', images: img('c', 'evil.com') },
      { id: 'd', rating: 'pg-13', images: {} },
      null,
    ],
  });
  assert.deepEqual(res, [
    { id: 'a', url: 'https://media1.giphy.com/media/a/200.gif', preview: 'https://media1.giphy.com/media/a/200w_d.gif', width: 356, height: 200, title: 'Wow' },
  ]);
  assert.deepEqual(parseGiphyResponse({ meta: {} }), []);
  assert.deepEqual(parseGiphyResponse(null), []);
});
