/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isFullOnlyRoute, redirectLink, routeOf, sitePath } from '../links';

const full = { store: false };
const store = { store: true };
const manifest = encodeURIComponent('https://addon.example/manifest.json');

test('site universal links map to app routes', () => {
  assert.equal(sitePath(`https://huwa.mciut.fr/addon?url=${manifest}`), `/addon?url=${manifest}`);
  assert.equal(sitePath(`https://www.huwa.mciut.fr/install?type=paperback&url=${manifest}`), `/install?type=paperback&url=${manifest}`);
  assert.equal(sitePath(`https://huwa.mciut.fr/extensions?url=${manifest}&type=stremio`), `/install?url=${manifest}&type=stremio`);
  assert.equal(sitePath('https://huwa.mciut.fr/pack.html#zAbC_-12'), '/pack?d=zAbC_-12');
  assert.equal(sitePath(`https://huwa.mciut.fr/pack#url=${manifest}`), `/pack?url=${manifest}`);
});

test('other site pages and incomplete links open the home screen', () => {
  assert.equal(sitePath('https://huwa.mciut.fr/'), '/');
  assert.equal(sitePath('https://huwa.mciut.fr/privacy.html'), '/');
  assert.equal(sitePath('https://huwa.mciut.fr/extensions'), '/');
  assert.equal(sitePath('https://huwa.mciut.fr/addon'), '/');
  assert.equal(sitePath('https://huwa.mciut.fr/pack.html'), '/');
});

test('links that are not ours are left alone', () => {
  assert.equal(sitePath('https://evil.example/addon?url=x'), undefined);
  assert.equal(sitePath('https://huwa.mciut.fr.evil.example/addon?url=x'), undefined);
  assert.equal(redirectLink('huwa://anime/al123', full), 'huwa://anime/al123');
  assert.equal(redirectLink(`huwa://addon?url=${manifest}`, full), `huwa://addon?url=${manifest}`);
});

test('store flavor: extension, pack, debrid and torrent links land on the home screen', () => {
  assert.equal(redirectLink(`huwa://addon?url=${manifest}`, store), '/');
  assert.equal(redirectLink(`huwa:///pack?d=abc`, store), '/');
  assert.equal(redirectLink(`https://huwa.mciut.fr/pack.html#abc`, store), '/');
  assert.equal(redirectLink('huwa://paperback?repo=x', store), '/');
  assert.equal(redirectLink('/debrid', store), '/');
  assert.equal(redirectLink('huwa://anime/al123', store), 'huwa://anime/al123');
  assert.equal(redirectLink('huwa://u/abcdef', store), 'huwa://u/abcdef');
});

test('route of a path or link', () => {
  assert.equal(routeOf('/addon?url=x'), 'addon');
  assert.equal(routeOf('huwa://pack?d=1'), 'pack');
  assert.equal(routeOf('huwa:///pack?d=1'), 'pack');
  assert.equal(routeOf('https://huwa.mciut.fr/install?url=x'), 'install');
  assert.equal(isFullOnlyRoute('/meta/tt1'), true);
  assert.equal(isFullOnlyRoute('/watch/x'), false);
});
