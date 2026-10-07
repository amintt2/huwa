/// <reference types="node" />
// Dub mode from A to Z (./dub.ts): which candidates the race may probe, when to wait, when to ask
// (popup, once per episode), the next episode's availability, what a series teaches.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DUB_MAYBE, langScore, NOT_DUBBED } from '../audio';
import {
  DUB_WAIT_MS,
  dubPhase,
  dubWaitLeft,
  getDubChoice,
  holdsStart,
  KNOWN_NO_DUB_WAIT_MS,
  knownNoDub,
  nextDubState,
  noteDub,
  raceCandidates,
  resetDubState,
  setDubChoice,
  showDubPrompt,
  splitDub,
  type DubPhaseInput,
} from '../dub';
import { probeTargets } from '../../torrent/peer-race';
import { decideStart, type RaceCandidate } from '../race';

const prefs = { watchMode: 'dub' as const, subLangs: ['fr'], dubLangs: ['fr'], translateSubs: true };
const st = (title: string) => ({ name: 'Addon', title });

// A typical French anime episode: few dubbed releases, many VOSTFR / raw ones.
const SOURCES = [
  st('Frieren S01E05 VOSTFR 1080p'),
  st('[SubsPlease] Frieren - 05 (1080p)'),
  st('Frieren S01E05 VF 1080p'),
  st('Frieren S01E05 VOSTFR 720p'),
  st('Frieren.S01E05.MULTi.1080p.WEB'),
  st('Frieren S01E05 RAW'),
  st('Frieren S01E05 VOSTFR 480p'),
  st('Frieren S01E05 English Dub'),
];
const ordered = [...SOURCES].sort((a, b) => langScore(a, prefs) - langScore(b, prefs));
const dubbed = (s: { title: string }) => langScore(s, prefs) < NOT_DUBBED;

const base: DubPhaseInput = {
  dubMode: true,
  autoFallback: false,
  dubAlive: 0,
  verifying: false,
  addonsPending: 0,
  elapsedMs: 0,
  knownNoDub: false,
  fallbacks: 3,
};

test('the race only spends its probes on dubbed candidates while any is alive', () => {
  const set = raceCandidates(ordered, 'dub', dubbed);
  assert.deepEqual(set.map((s) => s.title), ['Frieren S01E05 VF 1080p', 'Frieren.S01E05.MULTi.1080p.WEB']);
  // Named dub first, the probable one (MULTI, checked by its tracks) after.
  assert.equal(langScore(set[0], prefs), 0);
  assert.equal(langScore(set[1], prefs), DUB_MAYBE);
  // Budget of 4 probes (torrent race): never a VOSTFR / raw / English one.
  assert.deepEqual(probeTargets(set.map((s) => ({ key: s.title })), 4), ['Frieren S01E05 VF 1080p', 'Frieren.S01E05.MULTi.1080p.WEB']);
  // No dub left: every other version may be measured (nothing starts before the user chose).
  assert.equal(raceCandidates(ordered, 'missing', dubbed).length, SOURCES.length);
  assert.ok(holdsStart('missing') && holdsStart('searching') && !holdsStart('fallback') && !holdsStart('dub'));
});

test('dead dubbed candidates fall out; the other versions only count once none is left', () => {
  const dead = new Set(['Frieren S01E05 VF 1080p']);
  const { dub, other } = splitDub(ordered, dubbed, (s) => !dead.has(s.title));
  assert.deepEqual(dub.map((s) => s.title), ['Frieren.S01E05.MULTi.1080p.WEB']);
  assert.equal(other.length, 6);
  // Fallback order: VOSTFR before raw before the English dub.
  assert.match(other[0].title, /VOSTFR/);
  assert.match(other[other.length - 1].title, /English Dub/);
});

test('decideStart: a dubbed answer is never beaten by a faster VOSTFR one', () => {
  const now = Date.now();
  const cands: RaceCandidate[] = [
    { key: 'vf', lang: 0, quality: 720, bitrateMbps: 3, probing: true },
    { key: 'vostfr', lang: NOT_DUBBED, quality: 1080, bitrateMbps: 7, probing: false, result: { alive: true, ttfbMs: 100, mbps: 80, at: now } },
  ];
  assert.equal(decideStart(cands, 100).key, null);
  cands[0] = { ...cands[0], probing: false, result: { alive: true, ttfbMs: 900, mbps: 10, at: now } };
  assert.equal(decideStart(cands, 1000).key, 'vf');
});

test('phase: dub, waiting for slow addons, missing, chosen fallback', () => {
  assert.equal(dubPhase({ ...base, dubMode: false }), 'off');
  assert.equal(dubPhase({ ...base, dubAlive: 1 }), 'dub');
  // Addons still answering: wait (up to DUB_WAIT_MS).
  assert.equal(dubPhase({ ...base, addonsPending: 2, elapsedMs: 2000 }), 'searching');
  assert.equal(dubWaitLeft({ ...base, addonsPending: 2, elapsedMs: 2000 }), DUB_WAIT_MS - 2000);
  assert.equal(dubPhase({ ...base, addonsPending: 2, elapsedMs: DUB_WAIT_MS }), 'missing');
  // Every addon answered without a dub: ask at once.
  assert.equal(dubPhase(base), 'missing');
  // A track check still running: not yet.
  assert.equal(dubPhase({ ...base, verifying: true }), 'searching');
  // The series is known without dub: the popup comes sooner.
  assert.equal(dubPhase({ ...base, addonsPending: 2, elapsedMs: KNOWN_NO_DUB_WAIT_MS, knownNoDub: true }), 'missing');
  assert.equal(dubPhase({ ...base, addonsPending: 2, elapsedMs: 500, knownNoDub: true }), 'searching');
  // Chosen (or automatic) fallback.
  assert.equal(dubPhase({ ...base, choice: 'fallback' }), 'fallback');
  assert.equal(dubPhase({ ...base, autoFallback: true }), 'fallback');
  // Nothing at all: the usual "no source" explanation, not the dub popup.
  assert.equal(dubPhase({ ...base, fallbacks: 0 }), 'empty');
  assert.equal(dubPhase({ ...base, fallbacks: 0, addonsPending: 1 }), 'searching');
  // A dub showing up late wins over the popup.
  assert.equal(dubPhase({ ...base, dubAlive: 1, choice: 'menu' }), 'dub');
});

test('popup: shown once per episode, any choice ends it', () => {
  resetDubState();
  assert.equal(showDubPrompt('missing', getDubChoice('s1', 5)), true);
  assert.equal(showDubPrompt('searching', undefined), false);
  assert.equal(showDubPrompt('dub', undefined), false);
  setDubChoice('s1', 5, 'menu');
  assert.equal(showDubPrompt('missing', getDubChoice('s1', 5)), false);
  // Another episode asks again.
  assert.equal(showDubPrompt('missing', getDubChoice('s1', 6)), true);
  setDubChoice('s1', 6, 'back');
  assert.equal(showDubPrompt('missing', getDubChoice('s1', 6)), false);
  setDubChoice('s1', 7, 'fallback');
  assert.equal(dubPhase({ ...base, choice: getDubChoice('s1', 7) }), 'fallback');
});

test('next episode: available, missing (asked before the end), or unknown', () => {
  assert.equal(nextDubState('dub'), 'available');
  assert.equal(nextDubState('missing'), 'missing');
  // The automatic fallback still says the next episode is not dubbed.
  assert.equal(nextDubState('fallback'), 'missing');
  // Already accepted for the next episode: no warning.
  assert.equal(nextDubState('missing', 'fallback'), 'unknown');
  assert.equal(nextDubState('searching'), 'unknown');
  assert.equal(nextDubState(undefined), 'unknown');
});

test('series memory: a partially dubbed series', () => {
  let m = noteDub(undefined, 11, true);
  m = noteDub(m, 12, true);
  m = noteDub(m, 13, false);
  assert.equal(knownNoDub(m, 12), false);
  assert.equal(knownNoDub(m, 13), true);
  // The dub stopped at 12: 14 and later are likely without dub too.
  assert.equal(knownNoDub(m, 14), true);
  assert.equal(knownNoDub(m, 3), false);
  // A dub found later again (dub resumed): from there on, not known.
  m = noteDub(m, 15, true);
  assert.equal(knownNoDub(m, 16), false);
  // Never dubbed: two episodes checked without dub → every episode.
  let never = noteDub(undefined, 1, false);
  assert.equal(knownNoDub(never, 2), true);
  assert.equal(knownNoDub(never, 0), false);
  never = noteDub(never, 4, false);
  assert.equal(knownNoDub(never, 2), true);
  assert.equal(knownNoDub(undefined, 1), false);
});
