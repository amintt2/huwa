/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { streamSubLangs, langScore, languageMismatch, detectLangs } from '../../addons/audio';
import { subtitlesUrl } from '../../addons/protocol';
import { extraKey, rankSubtitles, sameRelease, subtitleExtraOf } from '../request';

test('subtitles URL carries videoHash, videoSize and filename as one extra segment', () => {
  const base = 'https://opensubtitles-v3.strem.io';
  assert.equal(subtitlesUrl(base, 'series', 'tt2560140:1:5'), `${base}/subtitles/series/tt2560140%3A1%3A5.json`);
  assert.equal(
    subtitlesUrl(base, 'series', 'kitsu:1:5', { filename: '[Erai-raws] Frieren - 05 [1080p].mkv', videoSize: 1468006400, videoHash: '8e245d9679d31e12' }),
    `${base}/subtitles/series/kitsu%3A1%3A5/videoHash=8e245d9679d31e12&videoSize=1468006400&filename=%5BErai-raws%5D%20Frieren%20-%2005%20%5B1080p%5D.mkv.json`,
  );
  // Missing values are left out.
  assert.equal(subtitlesUrl(base, 'movie', 'tt1', { filename: 'a b.mkv' }), `${base}/subtitles/movie/tt1/filename=a%20b.mkv.json`);
  assert.equal(subtitlesUrl(base, 'movie', 'tt1', {}), `${base}/subtitles/movie/tt1.json`);
});

test('extras come from the stream behaviorHints', () => {
  assert.equal(subtitleExtraOf(null), null);
  assert.equal(subtitleExtraOf({ name: 'x' }), null);
  assert.deepEqual(
    subtitleExtraOf({ behaviorHints: { filename: 'Season 1/Frieren 05.mkv', videoSize: 123.4, videoHash: '8E245D9679D31E12' } }),
    { filename: 'Frieren 05.mkv', videoSize: 123, videoHash: '8e245d9679d31e12' },
  );
  // A malformed hash is dropped, the rest kept.
  assert.deepEqual(subtitleExtraOf({ behaviorHints: { videoHash: 'nope', videoSize: 10 } }), { videoSize: 10 });
  assert.equal(extraKey({ filename: 'a', videoSize: 1 }), extraKey({ videoSize: 1, filename: 'a' }));
  assert.equal(extraKey(null), '');
});

test('ranking: exact matches first, then language order, then addon order', () => {
  const video = { filename: '[SubsPlease] Frieren - 05 (1080p) [ABCD1234].mkv' };
  const list = [
    { url: 'u1', lang: 'spa' },
    { url: 'u2', lang: 'eng' },
    { url: 'u3', lang: 'fre' },
    { url: 'u4', lang: 'eng', m: 'h' },
    { url: 'u5', lang: 'fre', release: 'SubsPlease Frieren 05 1080p' },
    { url: 'u6', lang: 'fre' },
  ];
  const ranked = rankSubtitles(list, ['fr', 'en'], video);
  assert.deepEqual(ranked.map((x) => x.url), ['u4', 'u5', 'u3', 'u6', 'u2', 'u1']);
  assert.equal(ranked[0].match, 'hash');
  assert.equal(ranked[1].match, 'release');
  assert.equal(ranked[2].match, undefined);
  assert.ok(sameRelease('[SubsPlease] Frieren - 05 (1080p).srt', video.filename));
  assert.ok(!sameRelease('[Erai-raws] Other Show - 12 [720p].srt', video.filename));
});

test('subtitles inside the stream count for the source choice (sub mode)', () => {
  const sub = { watchMode: 'sub' as const, subLangs: ['fr', 'en'], dubLangs: ['fr'] };
  const plain = { name: 'Frieren 05 1080p' };
  const withFr = { name: 'Frieren 05 1080p', subtitles: [{ url: 'https://x/fr.srt', lang: 'fre' }] };
  const withEn = { name: 'Frieren 05 1080p', subtitles: [{ url: 'https://x/en.srt', lang: 'eng' }] };
  assert.deepEqual(streamSubLangs(withFr), ['fr']);
  assert.ok(langScore(withFr, sub) < langScore(withEn, sub));
  assert.ok(langScore(withEn, sub) < langScore(plain, sub));
  // Release tags: MULTI carries French subtitles, "FR subs" too.
  assert.deepEqual(detectLangs({ name: 'Frieren E05 MULTI 1080p' }).subs, ['fr']);
  assert.deepEqual(detectLangs({ name: 'Frieren 05 [FR subs]' }).subs, ['fr']);
  assert.equal(langScore({ name: 'Frieren 05 VOSTFR 720p' }, sub), langScore(withFr, sub));
  // The banner knows about French tracks found later (embedded in the file).
  assert.equal(languageMismatch(plain, { ...sub, subLangs: ['fr'] }, ['eng']), 'Pas de VOSTFR trouvée : sous-titres anglais seulement');
  assert.equal(languageMismatch(plain, { ...sub, subLangs: ['fr'] }, ['eng', 'fr']), null);
  assert.equal(languageMismatch(withFr, { ...sub, subLangs: ['fr'] }, []), null);
});
