/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addCue } from '../live';
import { buildTracks, chooseTrack, syncTier } from '../select';
import { cuesDoc } from '../text';
import { translatedOnly, translatedTrack, translationSources, translationTarget } from '../translate';

const prefs = { subLangs: ['fr', 'en'], watchMode: 'sub' as const };

test('within a language, the track most likely in sync wins', () => {
  const tracks = buildTracks(
    [{ language: 'en' }],
    [
      { url: 'https://a/fr-any.srt', lang: 'fr', source: 'OpenSubtitles' },
      { url: 'https://a/fr-release.srt', lang: 'fr', source: 'OpenSubtitles', match: 'release' },
      { url: 'https://a/fr-hash.srt', lang: 'fr', source: 'OpenSubtitles', match: 'hash' },
    ],
  );
  assert.equal(chooseTrack(tracks, { enabled: true, languages: ['fr'] }), 'ext:https://a/fr-hash.srt');
  assert.deepEqual(tracks.map(syncTier), [0, 4, 2, 1]);
});

test('a file not made for this release does not stop the translation of an in-sync track', () => {
  const tracks = buildTracks([{ language: 'en' }], [{ url: 'https://a/fr-any.srt', lang: 'fr' }]);
  assert.equal(translationTarget(tracks, prefs), 'fr');
  // Embedded English is only a source when the engine gives its lines.
  assert.deepEqual(translationSources(tracks, prefs, false), []);
  const [src] = translationSources(tracks, prefs, true);
  assert.equal(src.key, 'emb:0');
  const tr = translatedTrack(src, 'fr');
  assert.equal(tr.fromEmbedded, 0);
  assert.equal(tr.fromSynced, true);
  // The in-sync translation beats the French file of unknown sync.
  assert.equal(chooseTrack([...tracks, tr], { enabled: true, languages: ['fr', 'en'] }), tr.key);
});

test('a French file made for this release needs no translation', () => {
  const tracks = buildTracks([{ language: 'en' }], [{ url: 'https://a/fr.srt', lang: 'fr', match: 'hash' }]);
  assert.equal(translationTarget(tracks, prefs), null);
});

test('translation sources: in-sync files before other ones, whatever the language order', () => {
  const tracks = buildTracks([], [
    { url: 'https://a/en-any.srt', lang: 'en' },
    { url: 'https://a/es-hash.srt', lang: 'es', match: 'hash' },
  ]);
  assert.deepEqual(translationSources(tracks, prefs).map((t) => t.lang), ['es', 'en']);
});

test('live lines: a newer line ends the one it replaces, repeats are ignored', () => {
  let list = addCue([], { start: 10, end: 14, text: 'Hello' });
  list = addCue(list, { start: 12, end: 15, text: 'Hello\nSign' });
  assert.deepEqual(list.map((c) => [c.start, c.end]), [[10, 12], [12, 15]]);
  assert.equal(addCue(list, { start: 12.01, end: 15, text: 'Hello\nSign' }), list);
});

test('live translation shows translated lines only', () => {
  const doc = cuesDoc([
    { start: 1, end: 2, text: 'Where are you going?' },
    { start: 3, end: 4, text: 'Wait!' },
  ]);
  const out = translatedOnly(doc, new Map([['Where are you going?', 'Où vas-tu ?']]));
  assert.deepEqual(out.events.map((e) => e.plain), ['Où vas-tu ?']);
});
