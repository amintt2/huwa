/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liveDoc, plainLine, translatedLive } from '../live';
import { buildTracks, chooseTrack, syncTier } from '../select';
import { sanitizeSubtitlePrefs } from '../prefs';
import { translatedTrack, translationSources, translationTarget } from '../translate';

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

const HEADER = [
  '[Script Info]',
  'PlayResX: 1920',
  'PlayResY: 1080',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Gandhi Sans,72,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,1,2,80,80,50,1',
  'Style: Sign-Web,Arial,60,&H00000000,&H000000FF,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,0,0,8,10,10,40,1',
  '[Events]',
  'Format: ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
].join('\n');

const line = (start: string, end: string, style: string, text: string, layer = 0) => `Dialogue: ${layer},${start},${end},${style},,0000,0000,0000,,${text}`;

test('live lines: spoken lines and signs, drawings, lyrics and screens of text left out', () => {
  const live = liveDoc(HEADER, [
    line('0:18:49.10', '0:18:52.00', 'Default', '{\\i1}Where are you{\\i0}\\Ngoing?'),
    line('0:18:49.10', '0:18:55.00', 'Default', '{\\pos(960,300)\\fs90}Hygiene search'),
    line('0:18:49.10', '0:18:55.00', 'Sign-Web', 'Results'),
    line('0:18:49.10', '0:18:55.00', 'Default', `{\\pos(960,500)}${'Hygiene in daily life. '.repeat(20)}`),
    line('0:18:49.10', '0:18:55.00', 'Default', '{\\p1}m 0 0 l 100 0 l 100 100{\\p0}'),
    line('0:18:49.10', '0:18:55.00', 'Default', '{\\pos(10,10)}LLLLLLLLLLLLLLLL'),
    line('0:18:49.10', '0:18:55.00', 'OP-Romaji', 'Chorogonzu'),
  ]);
  assert.deepEqual(live.doc.events.map((e) => e.plain), ['Where are you\ngoing?', 'Hygiene search', 'Results']);
  assert.equal(live.doc.playResY, 1080);
  assert.equal(live.signs.size, 2);
  assert.equal(live.doc.events[0].start, 18 * 60 + 49.1);
});

test('live translation: spoken lines as subtitles, signs as small notes where they are', () => {
  const live = liveDoc(HEADER, [
    line('0:00:01.00', '0:00:03.00', 'Default', 'Where are you going?'),
    line('0:00:01.00', '0:00:03.00', 'Default', '{\\pos(960,300)\\fs90}Hygiene search'),
    line('0:00:01.00', '0:00:01.04', 'Sign-Web', 'Results'),
    line('0:00:04.00', '0:00:05.00', 'Default', 'Wait!'),
  ]);
  const out = translatedLive(live, new Map([
    ['Where are you going?', 'Où vas-tu ?'],
    ['Hygiene search', "Recherche d'hygiène"],
    ['Results', 'Résultats'],
  ]));
  // "Wait!" is not translated yet: not drawn.
  assert.deepEqual(out.events.map((e) => e.plain), ['Où vas-tu ?', "Recherche d'hygiène", 'Résultats']);
  const [spoken, placed, slotted] = out.events;
  assert.equal(spoken.pos, undefined);
  assert.equal(spoken.style.name, 'Default');
  assert.deepEqual(placed.pos, { x: 960, y: 300 });
  assert.equal(placed.style.borderStyle, 3);
  assert.ok(placed.style.fontSize < 90 && placed.style.fontSize >= 1080 * 0.03);
  // A sign without \pos: anchored where its alignment and margins put it (top centre).
  assert.deepEqual(slotted.pos, { x: 960, y: 40 });
  // Darker box on demand (Réglages → Sous-titres).
  const dark = translatedLive(live, new Map([['Results', 'Résultats']]), 0.94);
  assert.equal(dark.events[0].style.outline.a, 0.94);
  // A one-frame sign (motion tracking) stays long enough to be read.
  assert.ok(slotted.end - slotted.start >= 2);
});

test('live lines from an older engine (plain text only)', () => {
  const live = liveDoc('', [plainLine(62.34, 65, 'Hello\nthere')]);
  assert.equal(live.doc.events[0].plain, 'Hello\nthere');
  assert.equal(live.doc.events[0].start, 62.34);
});

test('on-screen text can be left out of the live translation', () => {
  const lines = [
    line('0:00:01.00', '0:00:03.00', 'Default', 'Where are you going?'),
    line('0:00:01.00', '0:00:03.00', 'Sign-Web', 'Results'),
  ];
  const live = liveDoc(HEADER, lines, false);
  assert.deepEqual(live.doc.events.map((e) => e.plain), ['Where are you going?']);
  assert.equal(live.signs.size, 0);
});

test("subtitles stay on unless turned off in Réglages (the player's off button was saved by older builds)", () => {
  assert.equal(sanitizeSubtitlePrefs({ enabled: false }).enabled, true);
  assert.equal(sanitizeSubtitlePrefs({ enabled: false, enabledChosen: true }).enabled, false);
});
