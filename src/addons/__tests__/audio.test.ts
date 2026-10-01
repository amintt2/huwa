/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectLangs, langScore } from '../audio';

const s = (name: string, title = '') => ({ name, title });

test('detectLangs reads the usual release tags', () => {
  assert.deepEqual(detectLangs(s('Frieren S01E05 VOSTFR 1080p')).subs, ['fr']);
  assert.ok(detectLangs(s('Frieren S01E05 VOSTFR 1080p')).audio.includes('ja'));
  assert.deepEqual(detectLangs(s('Frieren E05 MULTI 1080p')).audio.sort(), ['fr', 'ja']);
  assert.deepEqual(detectLangs(s('Frieren E05 TRUEFRENCH 720p')).audio, ['fr']);
  assert.deepEqual(detectLangs(s('[Sub] Frieren - 05 Dual Audio')).audio.sort(), ['en', 'ja']);
  assert.deepEqual(detectLangs(s('Torrentio', 'Frieren 05 🇫🇷 🇯🇵')).audio.sort(), ['fr', 'ja']);
  assert.equal(detectLangs(s('Frieren 05 1080p')).label, null);
  // "VOSTFR" must not be read as a French dub.
  assert.ok(!detectLangs(s('Frieren VOSTFR')).audio.includes('fr'));
});

test('langScore follows the watch mode and language order', () => {
  const sub = { watchMode: 'sub' as const, subLangs: ['fr', 'en'], dubLangs: ['fr'] };
  const dub = { watchMode: 'dub' as const, subLangs: ['fr'], dubLangs: ['fr', 'en'] };
  const vostfr = s('Ep 5 VOSTFR');
  const vf = s('Ep 5 VF');
  const raw = s('Ep 5 1080p');
  const eng = s('Ep 5 English Dub');
  assert.ok(langScore(vostfr, sub) < langScore(raw, sub));
  assert.ok(langScore(raw, sub) < langScore(vf, sub));
  assert.ok(langScore(vf, dub) < langScore(eng, dub));
  assert.ok(langScore(eng, dub) < langScore(raw, dub));
});

test('languageMismatch tells what the chosen source lacks', async () => {
  const { languageMismatch, normLang } = await import('../audio');
  const prefs = { watchMode: 'sub' as const, subLangs: ['fr', 'en'], dubLangs: ['fr'] };
  // Spanish audio, English subtitles only, user wants VOSTFR (fr first, en accepted).
  assert.equal(languageMismatch({ name: 'x', title: 'Show 🇪🇸' }, prefs, ['eng']), 'Pas de VOSTFR trouvée : audio espagnol');
  assert.equal(languageMismatch({ name: 'x', title: 'Show 🇪🇸' }, { ...prefs, subLangs: ['fr'] }, ['eng']), 'Pas de VOSTFR trouvée : audio espagnol, sous-titres anglais seulement');
  assert.equal(languageMismatch({ name: 'x', title: 'Show VOSTFR' }, prefs, []), null);
  assert.equal(languageMismatch({ name: 'x', title: 'Show' }, { ...prefs, subLangs: ['fr'] }, []), 'Pas de VOSTFR trouvée : aucun sous-titre en français');
  assert.equal(languageMismatch({ name: 'x', title: 'Show MULTI' }, { ...prefs, watchMode: 'dub' }, []), null);
  assert.equal(normLang('fre'), 'fr');
  assert.equal(normLang('French'), 'fr');
});
