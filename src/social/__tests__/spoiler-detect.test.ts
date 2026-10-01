/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { laterReference, laterReferenceLabel } from '../spoiler-detect';

test('later episodes in an anime thread', () => {
  const ep12 = { episode: 12 };
  assert.deepEqual(laterReference('Attendez l’épisode 14…', ep12), { kind: 'ep', n: 14 });
  assert.deepEqual(laterReference('ep 13 va tout changer', ep12), { kind: 'ep', n: 13 });
  assert.deepEqual(laterReference('Ép. 20 et ép. 15', ep12), { kind: 'ep', n: 20 });
  assert.deepEqual(laterReference('dans S1E18 on voit', ep12), { kind: 'ep', n: 18 });
  assert.deepEqual(laterReference('E14 !', ep12), { kind: 'ep', n: 14 });
  assert.equal(laterReference('comme dans l’épisode 3', ep12), undefined);
  assert.equal(laterReference('épisode 12, quel épisode', ep12), undefined);
  assert.equal(laterReference('le 14 juillet', ep12), undefined);
  assert.equal(laterReference('une scène à 13:05', ep12), undefined);
  assert.equal(laterReference('The 14th', ep12), undefined);
});

test('chapters past what the episode adapts, and in manhwa threads', () => {
  assert.deepEqual(laterReference('le chapitre 120 est fou', { episode: 12, chapter: 60 }), { kind: 'ch', n: 120 });
  assert.equal(laterReference('le chapitre 120 est fou', { episode: 12 }), undefined);
  assert.deepEqual(laterReference('chap. 45 !!', { chapter: 40 }), { kind: 'ch', n: 45 });
  assert.deepEqual(laterReference('C45 spoil', { chapter: 40 }), { kind: 'ch', n: 45 });
  assert.equal(laterReference('ch 38 était mieux', { chapter: 40 }), undefined);
  // A manhwa thread does not flag anime episodes.
  assert.equal(laterReference('épisode 90', { chapter: 40 }), undefined);
});

test('already hidden: spoiler spans and code are not scanned', () => {
  assert.equal(laterReference('||épisode 14 il meurt||', { episode: 12 }), undefined);
  assert.equal(laterReference('`ep 99`', { episode: 12 }), undefined);
  assert.equal(laterReferenceLabel({ kind: 'ep', n: 14 }), 'l’épisode 14');
  assert.equal(laterReferenceLabel({ kind: 'ch', n: 3 }), 'le chapitre 3');
});
