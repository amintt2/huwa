/// <reference types="node" />
// Audio track choice: VO mode must play the original language on dual-audio releases whose
// default track is the English dub, keep it through seeks / track events / source switches, keep
// the user's own pick, and leave the dub mode as it was.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { createVideoPlayer, FakeMpvView, fileTracks, mpvViews, resetMedia } from '../../../../scripts/test-mocks/media.mjs';
import { AudioKeeper, audioCorrection, audioWish, chooseAudio, MAX_FIXES, mpvAlang, originalLang, WINDOW_MS, type AudioRef } from '../audio-pick';
import { getAudioChoice, setAudioChoice } from '../audio-choice';
import { HybridPlayer } from '../engines/hybrid-player';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A dual-audio release as AVPlayer / the mpv mapping report it: English dub first and default. */
const dual: AudioRef[] = [
  { id: 'a1', language: 'en', label: 'English' },
  { id: 'a2', language: 'ja', label: 'Japanese' },
];
const vo = audioWish({ dubbed: false, dubLangs: ['fr'], original: 'ja' });

afterEach(() => resetMedia());

test('original language from the AniList country of origin', () => {
  assert.equal(originalLang('JP'), 'ja');
  assert.equal(originalLang('KR'), 'ko');
  assert.equal(originalLang('CN'), 'zh');
  assert.equal(originalLang('TW'), 'zh');
  assert.equal(originalLang(undefined), 'ja');
});

test('VO mode, dual audio with English default: Japanese is picked', () => {
  assert.deepEqual(vo.langs, ['ja']);
  assert.equal(chooseAudio(dual, vo), 1);
  assert.equal(audioCorrection(dual, dual[0], vo), 1);
  assert.equal(audioCorrection(dual, dual[1], vo), -1);
  // Untagged tracks named by their title ("VO" / "VF").
  const titled: AudioRef[] = [{ id: 'x', language: 'und', label: 'VF' }, { id: 'y', language: 'und', label: 'VO' }];
  assert.equal(chooseAudio(titled, vo), 1);
  // Only one track, or none in the wanted language: the file's own choice stays.
  assert.equal(audioCorrection([dual[0]], dual[0], vo), -1);
  assert.equal(audioCorrection([dual[0], { id: 'a3', language: 'de', label: 'Deutsch' }], dual[0], vo), -1);
});

test('a seek / track-list event that flips back to English is corrected, without looping forever', () => {
  let now = 0;
  const k = new AudioKeeper(() => now);
  const uri = 'https://cdn.test/op-1000.mkv';
  // Load: default English → Japanese.
  assert.equal(k.check(uri, dual, dual[0], vo), 1);
  // The player reports Japanese: nothing to do.
  assert.equal(k.check(uri, dual, dual[1], vo), -1);
  // Seek back → the player flips to English again (track-list / media selection event).
  now += 30_000;
  assert.equal(k.check(uri, dual, dual[0], vo), 1);
  // A player that insists: a few corrections per window, then it is left alone.
  now += 1;
  for (let i = 1; i < MAX_FIXES; i++) assert.equal(k.check(uri, dual, dual[0], vo), 1);
  assert.equal(k.check(uri, dual, dual[0], vo), -1);
  now += WINDOW_MS;
  assert.equal(k.check(uri, dual, dual[0], vo), 1);
  // Another source (source controller switch, reload): checked again from scratch.
  assert.equal(k.check('https://cdn.test/other.mkv', dual, dual[0], vo), 1);
});

test('a manual pick is sticky: same series, next sources and episodes', () => {
  // The user chose English in VO mode for this series.
  const wish = audioWish({ dubbed: false, dubLangs: ['fr'], original: 'ja', manual: { lang: 'en', label: 'English' } });
  assert.deepEqual(wish.langs, ['en', 'ja']);
  const k = new AudioKeeper(() => 0);
  assert.equal(k.check('ep1', dual, dual[1], wish), 0);
  assert.equal(k.check('ep1', dual, dual[0], wish), -1, 'a seek keeps it');
  // Next episode / another release: track order and ids differ, the language is found again.
  const other: AudioRef[] = [{ id: 'b1', language: 'ja', label: 'Japonais' }, { id: 'b2', language: 'en', label: 'Anglais' }];
  assert.equal(k.check('ep2', other, other[0], wish), 1);
  // Two tracks of the language: the exact one picked (commentary vs main) is found by its title.
  const two: AudioRef[] = [
    { id: 'c1', language: 'ja', label: 'Japanese' },
    { id: 'c2', language: 'ja', label: 'Commentary' },
  ];
  const exact = audioWish({ dubbed: false, dubLangs: [], original: 'ja', manual: { lang: 'ja', label: 'Commentary' } });
  assert.equal(audioCorrection(two, two[0], exact), 1);
  assert.equal(audioCorrection(two, two[0], vo), -1, 'without a pick, any Japanese track is fine');
});

test('the manual pick is remembered per series and per watch mode', () => {
  setAudioChoice('al21', 'sub', { lang: 'en', label: 'English' });
  assert.deepEqual(getAudioChoice('al21', 'sub'), { lang: 'en', label: 'English' });
  assert.equal(getAudioChoice('al21', 'dub'), null, 'the dub mode keeps its own rule');
  assert.equal(getAudioChoice('al22', 'sub'), null, 'other series untouched');
  setAudioChoice('al21', 'sub', null);
  assert.equal(getAudioChoice('al21', 'sub'), null);
});

test('dub mode is unchanged: the dub languages, tag first then title', () => {
  const dub = audioWish({ dubbed: true, dubLangs: ['fr', 'en'], original: 'ja' });
  assert.deepEqual(dub.langs, ['fr', 'en']);
  const multi: AudioRef[] = [{ id: 'm1', language: 'ja', label: 'Japonais' }, { id: 'm2', language: 'und', label: 'VF' }];
  assert.equal(audioCorrection(multi, multi[0], dub), 1);
  assert.equal(audioCorrection(dual, dual[1], dub), 0, 'no French: English, the second dub language');
});

test('mpv alang lists ISO 639-1 and 639-2 codes', () => {
  assert.equal(mpvAlang(['ja']), 'ja,jpn');
  assert.equal(mpvAlang(['fr', 'en']), 'fr,fre,fra,en,eng');
});

test('mpv engine: alang before the load, Japanese selected over the English default, kept by the next file', async () => {
  const native = createVideoPlayer(null);
  const player = new HybridPlayer(native as never);
  // EngineView stand-in: mount the mpv surface once the engine is mpv.
  player.subscribeEngine(() =>
    setTimeout(() => {
      if (player.getEngine() !== 'mpv' || mpvViews.length) return;
      const v = new FakeMpvView();
      v.host = player.mpv;
      player.attachView(v as never);
      setTimeout(() => player.viewDidMount(), 1);
    }, 0),
  );
  const tracks = [
    { id: 1, type: 'audio', title: 'English', lang: 'eng', codec: 'aac', default: true, selected: true, external: false },
    { id: 2, type: 'audio', title: 'Japanese', lang: 'jpn', codec: 'aac', default: false, selected: false, external: false },
  ];
  const a = 'https://cdn.test/one-piece-a.mkv';
  const b = 'https://cdn.test/one-piece-b.mkv';
  fileTracks.set(a, tracks);
  // The next file lists Japanese first: a track id carried over would pick English there.
  fileTracks.set(b, [{ ...tracks[1], id: 1, selected: false }, { ...tracks[0], id: 2, selected: true }]);
  player.setAudioPreference(vo);

  await player.replaceAsync({ uri: a });
  const view = mpvViews[0];
  type Call = [string, ...unknown[]];
  const log = (): Call[] => view.calls as Call[];
  const calls = log().map((c) => c[0]);
  assert.ok(calls.indexOf('setAudioLanguages') >= 0 && calls.indexOf('setAudioLanguages') < calls.indexOf('load'), 'alang is set before the file opens');
  assert.deepEqual(log().find((c) => c[0] === 'setAudioLanguages'), ['setAudioLanguages', 'ja,jpn']);
  assert.equal(player.audioTrack?.language, 'ja');
  assert.deepEqual(log().filter((c) => c[0] === 'setAudioTrack').at(-1), ['setAudioTrack', 2]);

  await player.replaceAsync({ uri: b });
  await sleep(5);
  assert.equal(player.audioTrack?.language, 'ja');
  assert.deepEqual(log().filter((c) => c[0] === 'setAudioTrack').at(-1), ['setAudioTrack', 1]);
  player.release();
});
