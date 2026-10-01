/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fromLangPhrase } from '../lang';
import { parseSubtitleText } from '../parse';
import { buildTracks, chooseTrack, trackHint } from '../select';
import {
  applyTranslation,
  bcp47,
  eventSegments,
  nextSegments,
  translateDoc,
  translatedTrack,
  translationCacheKey,
  translationSources,
  translationTarget,
  windowCoverage,
  wrapLines,
} from '../translate';

const ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,10,10,40,1
Style: OP-Romaji,Arial,50,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,8,10,10,40,1
Style: Sign,Arial,50,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,5,10,10,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}Where are you going?{\\i0}\\NWait for me!
Dialogue: 0,0:00:02.00,0:00:04.00,OP-Romaji,,0,0,0,,{\\k20}Kimi no {\\k30}namae wa
Dialogue: 0,0:00:05.00,0:00:07.00,Sign,,0,0,0,,{\\pos(400,300)\\fad(200,200)}Tokyo Station
Dialogue: 1,0:00:05.00,0:00:07.00,Sign,,0,0,0,,{\\pos(400,300)\\fad(200,200)}Tokyo Station
Dialogue: 0,0:00:08.00,0:00:10.00,Default,,0,0,0,,- Run!\\N- I can't!
Dialogue: 0,0:00:11.00,0:00:12.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}
Dialogue: 0,0:10:00.00,0:10:02.00,Default,,0,0,0,,Much later.
`;

const doc = () => parseSubtitleText(ASS);

test('segments: plain text without tags or line breaks; songs and drawings left alone', () => {
  const ev = doc().events;
  const byStart = (s: number) => ev.filter((e) => e.start === s);
  assert.deepEqual(eventSegments(byStart(1)[0]), ['Where are you going? Wait for me!']);
  assert.equal(eventSegments(byStart(2)[0]), null);
  assert.deepEqual(eventSegments(byStart(5)[0]), ['Tokyo Station']);
  // Two speakers: one segment per line, dashes put back after translation.
  assert.deepEqual(eventSegments(byStart(8)[0]), ['Run!', "I can't!"]);
  assert.ok(ev.filter((e) => e.start === 11).every((e) => eventSegments(e) === null));
});

test('applyTranslation keeps timing, placement and style; restores line breaks', () => {
  const ev = doc().events;
  const line = ev.find((e) => e.start === 1)!;
  const out = applyTranslation(line, ['Où est-ce que tu vas ? Attends-moi !']);
  assert.equal(out.start, line.start);
  assert.equal(out.end, line.end);
  assert.equal(out.style, line.style);
  assert.equal(out.plain.split('\n').length, 2);
  assert.equal(out.plain.replace('\n', ' '), 'Où est-ce que tu vas ? Attends-moi !');
  // Dominant inline style kept (the italic part is the longest).
  assert.equal(out.spans.length, 1);
  assert.equal(out.spans[0].style.italic, true);
  const sign = ev.find((e) => e.start === 5)!;
  const s2 = applyTranslation(sign, ['Gare de Tokyo']);
  assert.deepEqual(s2.pos, sign.pos);
  assert.deepEqual(s2.fade, sign.fade);
  assert.equal(s2.plain, 'Gare de Tokyo');
  const dash = applyTranslation(ev.find((e) => e.start === 8)!, ['Cours !', 'Je ne peux pas !']);
  assert.equal(dash.plain, '- Cours !\n- Je ne peux pas !');
});

test('wrapLines balances lines at spaces', () => {
  assert.deepEqual(wrapLines('un deux trois quatre', 2), ['un deux', 'trois quatre']);
  assert.deepEqual(wrapLines('Bonjour', 2), ['Bonjour']);
  assert.deepEqual(wrapLines('  a  b  ', 1), ['a b']);
  assert.equal(wrapLines('a bb ccc dddd eeeee ffffff', 3).length, 3);
});

test('translateDoc replaces translated events only, same object when nothing changes', () => {
  const d = doc();
  assert.equal(translateDoc(d, new Map()), d);
  const out = translateDoc(d, new Map([['Tokyo Station', 'Gare de Tokyo']]));
  assert.notEqual(out, d);
  // (The parser already merged the two identical layers of the sign.)
  assert.equal(out.events.filter((e) => e.plain === 'Gare de Tokyo').length, 1);
  assert.equal(out.events.filter((e) => e.plain === 'Tokyo Station').length, 0);
  assert.equal(out.events.find((e) => e.start === 1)!.plain, d.events.find((e) => e.start === 1)!.plain);
});

test('window: segments around playback, earliest first, deduplicated, capped', () => {
  const ev = doc().events;
  const none = () => false;
  assert.deepEqual(nextSegments(ev, 0, none, { ahead: 60, behind: 5, max: 10 }), [
    'Where are you going? Wait for me!',
    'Tokyo Station',
    'Run!',
    "I can't!",
  ]);
  assert.deepEqual(nextSegments(ev, 0, none, { ahead: 60, behind: 5, max: 2 }), ['Where are you going? Wait for me!', 'Tokyo Station']);
  // Known ones skipped; far cues wait until playback gets near.
  const known = new Set(['Where are you going? Wait for me!', 'Tokyo Station']);
  assert.deepEqual(nextSegments(ev, 0, (s) => known.has(s), { ahead: 60, behind: 5, max: 10 }), ['Run!', "I can't!"]);
  assert.deepEqual(nextSegments(ev, 590, none, { ahead: 60, behind: 5, max: 10 }), ['Much later.']);
  // Past cues (beyond `behind`) are not translated after a seek forward.
  assert.deepEqual(nextSegments(ev, 30, none, { ahead: 60, behind: 5, max: 10 }), []);
  assert.equal(windowCoverage(ev, 0, (s) => known.has(s), { ahead: 60, behind: 5, max: 10 }), 0.5);
});

test('cache keys: per subtitle URL and language pair, file-safe', () => {
  const a = translationCacheKey('https://os/sub/1.srt', 'eng', 'fr');
  assert.equal(a, translationCacheKey('https://os/sub/1.srt', 'en', 'fr'));
  assert.notEqual(a, translationCacheKey('https://os/sub/2.srt', 'en', 'fr'));
  assert.notEqual(a, translationCacheKey('https://os/sub/1.srt', 'en', 'es'));
  assert.match(a, /^[a-z0-9-]+$/);
  assert.ok(a.endsWith('-en-fr'));
});

test('translation needed only when the primary language has no full track', () => {
  const prefs = { subLangs: ['fr', 'en'], watchMode: 'sub' as const };
  const enOnly = buildTracks([], [
    { url: 'https://os/es.srt', lang: 'spa', source: 'OS' },
    { url: 'https://os/en.srt', lang: 'eng', source: 'OS' },
    { url: 'https://os/en-forced.srt', lang: 'eng', source: 'OS', label: 'Forced' },
  ]);
  assert.equal(translationTarget(enOnly, prefs), 'fr');
  // English first (second preferred language), forced tracks never used as a source.
  assert.deepEqual(translationSources(enOnly, prefs).map((t) => t.url), ['https://os/en.srt', 'https://os/es.srt']);
  // A native French track (even embedded) → no translation.
  const withFr = buildTracks([{ language: 'fre', label: 'Français' }], [{ url: 'https://os/en.srt', lang: 'en' }]);
  assert.equal(translationTarget(withFr, prefs), null);
  assert.deepEqual(translationSources(withFr, prefs), []);
  // A French signs-only track does not count.
  const signs = buildTracks([{ language: 'fr', name: 'Signs & Songs' }], [{ url: 'https://os/en.srt', lang: 'en' }]);
  assert.equal(translationTarget(signs, prefs), 'fr');
  // Watching a dub, or nothing readable (embedded English only): no translation.
  assert.equal(translationTarget(enOnly, { ...prefs, watchMode: 'dub' }), null);
  assert.deepEqual(translationSources(buildTracks([{ language: 'en' }], []), prefs), []);
});

test('translated track: chosen over English for a French viewer, labelled', () => {
  const prefs = { subLangs: ['fr', 'en'], watchMode: 'sub' as const };
  const base = buildTracks([], [{ url: 'https://os/en.srt', lang: 'eng', source: 'OpenSubtitles' }]);
  const src = translationSources(base, prefs)[0];
  const tr = translatedTrack(src, 'fr');
  assert.equal(tr.name, 'Français (traduit automatiquement)');
  assert.equal(tr.fromLang, 'en');
  assert.equal(trackHint(tr), 'Traduit sur l’appareil depuis l’anglais');
  assert.equal(chooseTrack([...base, tr], { enabled: true, languages: prefs.subLangs }), tr.key);
  // A real French file wins over the translation.
  const fr = buildTracks([], [{ url: 'https://os/fr.srt', lang: 'fre' }]);
  assert.equal(chooseTrack([...fr, tr], { enabled: true, languages: ['fr'] }), 'ext:https://os/fr.srt');
  assert.equal(fromLangPhrase('pt'), 'depuis le portugais');
  assert.equal(fromLangPhrase('es'), 'depuis l’espagnol');
  assert.equal(bcp47('pt-br'), 'pt-BR');
  assert.equal(bcp47('en'), 'en');
});
