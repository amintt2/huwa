/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startStreamInput } from '../stream-input';

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
