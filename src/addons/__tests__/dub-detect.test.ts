/// <reference types="node" />
// Dub naming conventions read from release names (./audio `detectLangs`, `classifyDub`), and the
// tracks of the file overriding the name.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyDub, detectLangs, fallbackName, langScore, NOT_DUBBED, DUB_MAYBE } from '../audio';

const s = (title: string, name = 'Addon') => ({ name, title });
const audio = (title: string) => detectLangs(s(title)).audio.sort();
const tier = (title: string, langs = ['fr']) => classifyDub(s(title), langs).tier;

test('French dub tags', () => {
  for (const t of [
    'Frieren S01E05 VF 1080p',
    'Frieren.S01E05.VFF.1080p.WEB',
    'Frieren S01E05 VFQ 720p',
    'Frieren S01E05 VFI',
    'Frieren.S01E05.TRUEFRENCH.1080p',
    'Frieren.S01E05.FRENCH.1080p.WEB.H264',
    'Frieren 05 [VF+VOSTFR]',
    'Frieren 05 VOSTFR+VF',
    'Frieren - 05 (Version française)',
    'Frieren 05 Dual Audio FR',
    'Frieren 05 French Dub',
    'Torrentio\nFrieren 05 🇫🇷',
  ]) {
    assert.ok(audio(t).includes('fr'), t);
    assert.equal(tier(t), 'dub', t);
  }
  // VF + VOSTFR packs carry both.
  assert.deepEqual(detectLangs(s('Frieren 05 [VF+VOSTFR]')).subs, ['fr']);
  assert.equal(detectLangs(s('Frieren 05 [VF+VOSTFR]')).label, '🇫🇷 VF + VOSTFR');
});

test('MULTI is only a probable French dub (confirmed by the tracks)', () => {
  assert.deepEqual(audio('Frieren.S01E05.MULTi.1080p.WEB'), ['fr', 'ja']);
  assert.deepEqual(detectLangs(s('Frieren.S01E05.MULTi.1080p')).implied, ['fr']);
  assert.equal(tier('Frieren.S01E05.MULTi.1080p'), 'maybe');
  // Named French next to it: a real dub.
  assert.equal(tier('Frieren.S01E05.MULTi.VFF.1080p'), 'dub');
  assert.equal(tier('Frieren.S01E05.MULTi.TRUEFRENCH.1080p'), 'dub');
  // "Multi-Subs" / "Multi-Audio" / "Multi Dub" say nothing about a French track.
  assert.ok(!audio('Show S01E01 1080p Multi-Subs').includes('fr'));
  assert.ok(!audio('Show S01E01 MULTi-Audio').includes('fr'));
  assert.ok(!audio('Show S01E01 Multi Dub').includes('fr'));
  assert.equal(tier('Show S01E01 MULTi-Audio'), 'maybe');
});

test('subtitle tags are never read as audio', () => {
  for (const t of ['Frieren 05 VOSTFR 1080p', 'Frieren.05.SUBFRENCH.1080p', 'Frieren 05 French Subs', 'Frieren 05 [Sub FR]', 'Frieren 05 ST FR', 'Frieren 05 FRENCH SUBBED', 'Frieren 05 sous-titres français']) {
    assert.ok(!audio(t).includes('fr'), t);
    assert.ok(detectLangs(s(t)).subs.includes('fr'), t);
    assert.equal(tier(t), t.includes('VOST') ? 'no' : tier(t), t);
  }
  assert.equal(tier('Frieren 05 VOSTFR 1080p'), 'no');
  // Torrentio puts 🇫🇷 on a VOSTFR release: still not a dub.
  assert.equal(tier('Frieren 05 VOSTFR 🇫🇷'), 'no');
  // Italian subtitles are not an Italian dub.
  assert.ok(!audio('Frieren 05 SUB ITA 1080p').includes('it'));
  assert.equal(tier('Frieren 05 SUB ITA 1080p', ['it']), 'maybe');
  // A multi-subtitle code list (Erai-raws style) names subtitle languages.
  assert.ok(!audio('[Erai-raws] Frieren - 05 [1080p][Multiple Subtitle][ENG][POR-BR][SPA-LA][FRE][GER][ITA]').includes('it'));
});

test('other dub languages', () => {
  // English
  assert.equal(tier('[Judas] Frieren - 05 (Dub)', ['en']), 'dub');
  assert.equal(tier('Frieren 05 English Dub 1080p', ['en']), 'dub');
  assert.equal(tier('Frieren Episode 5 Dubbed', ['en']), 'dub');
  assert.deepEqual(audio('[Sub] Frieren - 05 Dual Audio'), ['en', 'ja']);
  assert.equal(tier('[Sub] Frieren - 05 Dual Audio', ['en']), 'maybe');
  assert.equal(tier('Frieren 05 Dual Audio [ENG-JAP]', ['en']), 'dub');
  // A Dual Audio naming another language is not English.
  assert.equal(tier('Frieren 05 Dual Audio Latino', ['en']), 'no');
  // Spanish
  assert.equal(tier('Frieren 05 Latino 1080p', ['es']), 'dub');
  assert.equal(tier('Frieren 05 Castellano', ['es']), 'dub');
  assert.equal(tier('Frieren 05 Dual Audio Latino', ['es']), 'dub');
  assert.ok(detectLangs(s('Frieren 05 VOSE')).subs.includes('es'));
  assert.equal(tier('Frieren 05 VOSE', ['es']), 'maybe');
  // German
  assert.equal(tier('Frieren.S01E05.German.Dub.1080p', ['de']), 'dub');
  assert.equal(tier('Frieren.S01E05.GERMAN.DL.1080p', ['de']), 'dub');
  assert.ok(!audio('Frieren 05 German Subs').includes('de'));
  // Italian
  assert.equal(tier('Frieren.S01E05.ITA.JPN.1080p', ['it']), 'dub');
  assert.equal(tier('Frieren 05 Italian Dub', ['it']), 'dub');
  // Portuguese
  assert.equal(tier('Frieren 05 Dublado 1080p', ['pt']), 'dub');
  assert.equal(tier('Frieren 05 Legendado', ['pt']), 'maybe');
  assert.ok(detectLangs(s('Frieren 05 Legendado')).subs.includes('pt'));
  assert.equal(tier('Frieren 05 Dual Áudio', ['pt']), 'maybe');
});

test('explicitly another language is skipped, untagged is "maybe"', () => {
  assert.equal(tier('Frieren 05 English Dub'), 'no');
  assert.equal(tier('Frieren 05 RAW 1080p'), 'no');
  assert.equal(tier('Frieren 05 Latino'), 'no');
  assert.equal(tier('[SubsPlease] Frieren - 05 (1080p)'), 'no');
  assert.equal(tier('Frieren - 05 (1080p) [ABCD1234]'), 'maybe');
});

test('the file tracks override the release name, both ways', () => {
  // "MULTI" without a French track.
  assert.equal(classifyDub(s('Frieren 05 MULTi'), ['fr'], { langs: ['ja', 'en'], conclusive: true }).tier, 'no');
  // Untagged release with a French track.
  const d = classifyDub(s('Frieren - 05 (1080p)'), ['fr'], { langs: ['fr', 'ja'], conclusive: true });
  assert.equal(d.tier, 'dub');
  assert.equal(d.verified, true);
  // "VF" in the name but only a Japanese track: not dubbed.
  assert.equal(classifyDub(s('Frieren 05 VF'), ['fr'], { langs: ['ja'], conclusive: true }).tier, 'no');
  // Inconclusive tracks (one says nothing): the name still counts.
  assert.equal(classifyDub(s('Frieren 05 VF'), ['fr'], { langs: ['ja'], conclusive: false }).tier, 'dub');
});

test('dub-mode scores: named dub < maybe < not dubbed (VOSTFR before raw)', () => {
  const dub = { watchMode: 'dub' as const, subLangs: ['fr'], dubLangs: ['fr'] };
  assert.equal(langScore(s('Frieren 05 VF'), dub), 0);
  assert.equal(langScore(s('Frieren 05 MULTi'), dub), DUB_MAYBE);
  assert.ok(langScore(s('Frieren 05 VOSTFR'), dub) >= NOT_DUBBED);
  assert.ok(langScore(s('Frieren 05 VOSTFR'), dub) < langScore(s('Frieren 05 English Dub'), dub));
  // Verified French track: a dub whatever the name.
  assert.equal(langScore(s('Frieren 05 (1080p)'), dub, { langs: ['fr'], conclusive: true }), 0);
});

test('fallback names', () => {
  assert.equal(fallbackName(s('Frieren 05 VOSTFR'), ['fr']), 'VOSTFR');
  assert.equal(fallbackName(s('Frieren 05 Eng Subs'), ['en']), 'VO sous-titrée anglais');
  assert.equal(fallbackName(s('Frieren 05 English Dub'), ['fr']), 'VA');
  assert.equal(fallbackName(s('Frieren 05 RAW'), ['en']), 'VO');
  // VO without subtitle tags, French subtitles from the addons / translation: still VOSTFR.
  assert.equal(fallbackName(s('[SubsPlease] Frieren - 05'), ['fr'], true), 'VOSTFR');
});
