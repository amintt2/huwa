/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUTO_LINK_SCORE,
  bestTitleScore,
  candidateScore,
  chapterPlausibility,
  normalizeForMatch,
  pickCatalogMatch,
  rankCandidates,
  searchQueries,
  splitAltTitles,
  titleSimilarity,
  type SeriesTitles,
} from '../match';

test('normalization: case, accents, punctuation, notes, articles', () => {
  assert.equal(normalizeForMatch('  The Beginning After The End  '), 'beginning after the end');
  assert.equal(normalizeForMatch('Héroïne: l’Épée & le Bouclier!'), 'heroine lepee and le bouclier');
  assert.equal(normalizeForMatch('Tower of God (Official)'), 'tower of god');
  assert.equal(normalizeForMatch('Nano Machine [Webtoon]'), 'nano machine');
  assert.equal(normalizeForMatch('나 혼자만 레벨업'), '나 혼자만 레벨업');
});

test('same title written differently scores 1', () => {
  assert.equal(titleSimilarity('Omniscient Reader’s Viewpoint', "omniscient reader's viewpoint"), 1);
  assert.equal(titleSimilarity('Solo-Leveling', 'Solo Leveling'), 1);
  assert.equal(titleSimilarity('The Greatest Estate Developer', 'Greatest Estate Developer'), 1);
});

test('sequels, spin-offs and unrelated titles stay below the auto-link threshold', () => {
  assert.ok(titleSimilarity('Solo Leveling', 'Solo Leveling: Ragnarok') < AUTO_LINK_SCORE);
  assert.ok(titleSimilarity('Tower of God', 'Tower of God: Urek Mazino') < AUTO_LINK_SCORE);
  assert.ok(titleSimilarity('Omniscient Reader', 'Omniscient Reader’s Viewpoint') < AUTO_LINK_SCORE);
  assert.ok(titleSimilarity('Solo Leveling', 'Eleceed') < 0.3);
  assert.equal(titleSimilarity('', 'x'), 0);
});

test('small typos stay close', () => {
  assert.ok(titleSimilarity('The Breaker: Eternal Force', 'The Breaker Eternal Forces') >= AUTO_LINK_SCORE);
  assert.ok(titleSimilarity('Reaper of the Drifting Moon', 'Reaper of the Drifting Moon.') === 1);
});

test('alternative titles: the best pair wins', () => {
  const ours = ['Solo Leveling', 'Ore dake Level Up na Ken', '나 혼자만 레벨업'];
  assert.equal(bestTitleScore(ours, ['Only I Level Up', '나 혼자만 레벨업']), 1);
  assert.equal(bestTitleScore(ours, ['I Alone Level-Up']) < AUTO_LINK_SCORE, true);
});

test('chapter plausibility', () => {
  const finished = { chapters: 200, finished: true };
  assert.equal(chapterPlausibility(finished, 201), 1);
  assert.equal(chapterPlausibility(finished, 120), 0.7);
  assert.equal(chapterPlausibility(finished, 12), 0.3);
  assert.equal(chapterPlausibility(finished, 0), 0);
  assert.equal(chapterPlausibility({ chapters: null, finished: false }, 3), 1);
  assert.equal(chapterPlausibility({ chapters: 100, finished: false }, 180), 1, 'ongoing: more chapters than AniList knows is fine');
});

const target: SeriesTitles = { titles: ['Solo Leveling', 'Na Honjaman Level Up', '나 혼자만 레벨업'], chapters: 179, finished: true };

test('candidate score uses chapter count as a sanity check', () => {
  assert.equal(candidateScore(target, ['Solo Leveling'], 200), 1);
  assert.ok(candidateScore(target, ['Solo Leveling'], 10) < AUTO_LINK_SCORE, 'a 10-chapter "Solo Leveling" is suspicious');
  assert.equal(candidateScore(target, ['Solo Leveling']), 1, 'unknown count: titles only');
});

test('ranking across sources: score, then source priority, weak ones dropped', () => {
  const ranked = rankCandidates(
    target,
    [
      { sourceKey: 'b', mangaId: '1', title: 'Solo Leveling' },
      { sourceKey: 'a', mangaId: '2', title: 'Solo Leveling' },
      { sourceKey: 'a', mangaId: '3', title: 'Solo Leveling: Ragnarok' },
      { sourceKey: 'c', mangaId: '4', title: 'Eleceed' },
    ],
    ['a', 'b'],
  );
  assert.deepEqual(ranked.map((c) => `${c.sourceKey}:${c.mangaId}`), ['a:2', 'b:1', 'a:3']);
  assert.equal(ranked[0].score, 1);
});

test('search queries: distinct, latin first, bounded', () => {
  assert.deepEqual(searchQueries(['나 혼자만 레벨업', 'Solo Leveling', 'solo leveling', 'Only I Level Up', 'Ore dake']), ['Solo Leveling', 'Only I Level Up', 'Ore dake']);
  assert.deepEqual(searchQueries(['나 혼자만 레벨업'], 3), ['나 혼자만 레벨업']);
  assert.deepEqual(searchQueries(['', ' ', 'x']), []);
});

// ---------- source title → catalog entry ----------


test('alternative titles listed in one string are split, odd titles kept whole', () => {
  const t = splitAltTitles(['SSM, The Lone Sword Master, 나 혼자 소드마스터']);
  assert.ok(t.includes('The Lone Sword Master'));
  assert.ok(t.includes('나 혼자 소드마스터'));
  assert.ok(t.includes('SSM, The Lone Sword Master, 나 혼자 소드마스터'));
  assert.deepEqual(splitAltTitles(['Fate/Zero']), ['Fate/Zero']);
  assert.deepEqual(splitAltTitles(['Solo Leveling - Ragnarok']), ['Solo Leveling - Ragnarok']);
  assert.ok(splitAltTitles(['A Returner ; Le retour']).includes('Le retour'));
});

const solo = { id: 'alm1', titles: ['Solo Leveling', 'Na Honjaman Level Up', '나 혼자만 레벨업'], chapters: 179, finished: true };
const ragnarok = { id: 'alm2', titles: ['Solo Leveling: Ragnarok', 'Na Honjaman Level Up: Ragnarok'], chapters: null, finished: false };
const swordmaster = { id: 'alm3', titles: ['Solo Swordmaster', 'Na Honja Sword Master'], chapters: null, finished: false };

test('a source title links to its catalog entry when sure', () => {
  assert.deepEqual(pickCatalogMatch(['Solo Leveling'], 200, [ragnarok, solo])?.id, 'alm1');
  assert.equal(pickCatalogMatch(['Solo Leveling: Ragnarok'], 68, [solo, ragnarok])?.id, 'alm2');
  assert.equal(pickCatalogMatch(splitAltTitles(['Solo Swordmaster', 'SSM, 나 혼자 소드마스터']), 20, [swordmaster, solo])?.id, 'alm3');
});

test('no link when unsure, implausible or refused', () => {
  assert.equal(pickCatalogMatch(['Solo Leveling Side'], 10, [solo]), null); // only similar
  assert.equal(pickCatalogMatch(['Solo Leveling'], 4, [solo]), null); // 4 chapters for a finished 179-chapter series
  assert.equal(pickCatalogMatch(['Solo Leveling'], 200, [solo], new Set(['alm1'])), null);
  const twin = { ...solo, id: 'alm9' };
  assert.equal(pickCatalogMatch(['Solo Leveling'], 200, [solo, twin]), null); // two entries with that title
});
