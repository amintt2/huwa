/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSavedAddons } from '../saved';

const builtin = { baseUrl: 'builtin:demo', enabled: true, manifest: { id: 'huwa.demo', name: 'Démo', resources: ['stream'] } };

test('saved add-ons: malformed entries from storage (or an imported file) are dropped', () => {
  const manifest = { id: 'x', name: 'X', resources: ['stream'] };
  const out = parseSavedAddons([
    { baseUrl: 'builtin:demo', enabled: false },
    { baseUrl: 'https://a.io', enabled: true, manifest },
    { baseUrl: 'https://a.io', enabled: true, manifest }, // duplicate
    { baseUrl: 'javascript:alert(1)', enabled: true, manifest },
    { baseUrl: 'https://b.io', enabled: true, manifest: { id: 1 } },
    { baseUrl: 42 },
    null,
    'nope',
  ], builtin);
  assert.deepEqual(
    out.map((a) => [a.baseUrl, a.enabled]),
    [
      ['builtin:demo', false],
      ['https://a.io', true],
    ],
  );
  assert.equal(out[0].manifest.id, 'huwa.demo', 'built-in manifest rebuilt, never taken from storage');
  assert.deepEqual(parseSavedAddons({ not: 'an array' }, builtin), []);
});
