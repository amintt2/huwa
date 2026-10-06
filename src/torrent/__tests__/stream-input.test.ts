/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { engineHashOf, startStreamInput } from '../stream-input';

test('engine URLs are recognised, with or without the container extension', () => {
  const h = 'ab'.repeat(20);
  assert.equal(engineHashOf(`http://127.0.0.1:53211/${h}/3`), h);
  assert.equal(engineHashOf(`http://127.0.0.1:53211/${h.toUpperCase()}/3.mkv`), h);
  assert.equal(engineHashOf(`http://127.0.0.1:53211/${h}/auto`), h);
  assert.equal(engineHashOf(`http://127.0.0.1:53211/${h}/auto.mp4`), h);
  assert.equal(engineHashOf('http://127.0.0.1:8081/stream/0/video.webm'), null, 'another local server');
  assert.equal(engineHashOf(`https://cdn.example/${h}/3.mkv`), null);
  assert.equal(engineHashOf(undefined), null);
});

test('startStream carries the metered flag to the engine', () => {
  const s = { infoHash: 'ab'.repeat(20), fileIdx: 2, sources: ['tracker:udp://t.example:80'], title: 'Show 01\n1080p' };
  assert.deepEqual(startStreamInput(s, true), {
    infoHash: s.infoHash,
    fileIdx: 2,
    sources: s.sources,
    name: 'Show 01',
    metered: true,
  });
  assert.equal(startStreamInput(s, false).metered, false);
  assert.deepEqual(startStreamInput({ infoHash: 'x' }, false), { infoHash: 'x', fileIdx: null, sources: [], name: undefined, metered: false });
});
