/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dropDemoWhenReal } from '../builtin-demo';

const demo = { a: { baseUrl: 'builtin:demo' } };
const torrentio = { a: { baseUrl: 'https://torrentio.strem.fun/language=french' } };
const subs = { a: { baseUrl: 'https://opensubtitles-v3.strem.io' } };

test('the demo source steps aside as soon as a real addon is asked for the episode', () => {
  // Regression: its direct test links were "safe" in auto mode and always beat the torrents
  // (the torrent race never started, the Mux test stream played instead of the episode).
  assert.deepEqual(dropDemoWhenReal([demo, torrentio], 'builtin:demo', 'stream'), [torrentio]);
});

test('the demo source stays when it is the only stream source (zero setup)', () => {
  assert.deepEqual(dropDemoWhenReal([demo], 'builtin:demo', 'stream'), [demo]);
  assert.deepEqual(dropDemoWhenReal([], 'builtin:demo', 'stream'), []);
});

test('other resources are untouched', () => {
  assert.deepEqual(dropDemoWhenReal([subs], 'builtin:demo', 'subtitles'), [subs]);
});
