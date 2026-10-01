/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyNoSource, type NoSourceInput } from '../no-source';

const base: NoSourceInput = {
  asked: 2, pending: 0, deciding: false, streams: 0, failed: [], torrents: 0,
  canResolveTorrents: false, engineAvailable: false, playable: 0, dead: 0,
};
const kind = (x: Partial<NoSourceInput>) => classifyNoSource({ ...base, ...x });

test('nothing to say while searching or deciding', () => {
  assert.equal(kind({ pending: 1 }), null);
  assert.equal(kind({ deciding: true, streams: 3, playable: 3 }), null);
  assert.equal(kind({ streams: 3, playable: 3 }), null, 'something can play');
});

test('no addon installed → add one', () => {
  const r = kind({ asked: 0 });
  assert.equal(r?.kind, 'no-addon');
  assert.equal(r?.action?.kind, 'addons');
});

test('every addon failed → retry; some failed and nothing found → retry; all answered empty → add an addon', () => {
  assert.equal(kind({ failed: ['A', 'B'] })?.kind, 'addons-failed');
  assert.equal(kind({ failed: ['A', 'B'] })?.action?.kind, 'retry');
  assert.match(kind({ failed: ['A', 'B'] })!.message, /A et B/);
  assert.equal(kind({ failed: ['A'] })?.kind, 'nothing-found');
  assert.equal(kind({ failed: ['A'] })?.action?.kind, 'retry');
  assert.equal(kind({})?.kind, 'nothing-found');
  assert.equal(kind({})?.action?.kind, 'addons');
});

test('only torrents: enable the engine when it exists, else a debrid service', () => {
  assert.equal(kind({ streams: 4, torrents: 4, engineAvailable: true })?.action?.kind, 'enable-engine');
  assert.equal(kind({ streams: 4, torrents: 4 })?.action?.kind, 'debrid');
  // A direct link exists too: not "torrents only".
  assert.equal(kind({ streams: 5, torrents: 4, playable: 1 }), null);
});

test('every playable link dead → search again; only pages / YouTube → open the sources', () => {
  const dead = kind({ streams: 3, playable: 3, dead: 3 });
  assert.equal(dead?.kind, 'all-dead');
  assert.equal(dead?.action?.kind, 'retry');
  assert.match(dead!.message, /3 liens/);
  assert.equal(kind({ streams: 3, playable: 3, dead: 2 }), null);
  assert.equal(kind({ streams: 2 })?.kind, 'unsupported');
});
