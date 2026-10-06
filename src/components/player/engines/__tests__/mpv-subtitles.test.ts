/// <reference types="node" />
// Subtitles drawn by mpv follow the app's subtitle settings; styled ASS goes to libass.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parseSubtitleText } from '@/subtitles/parse';
import { DEFAULT_SUBTITLE_PREFS } from '@/subtitles/prefs';

import { libassRenders, mpvSubtitleOptions } from '../mpv-subtitles';

test('user style → mpv sub options (720-line scaled pixels, #AARRGGBB, + = later)', () => {
  const o = mpvSubtitleOptions(DEFAULT_SUBTITLE_PREFS, 1.25);
  assert.equal(o['sub-ass-override'], 'scale');
  assert.equal(o['sub-font'], 'Nunito');
  assert.equal(o['sub-font-size'], String(Math.round(0.059 * 720)));
  assert.equal(o['sub-bold'], 'yes');
  assert.equal(o['sub-color'], '#FFFFFF');
  assert.equal(o['sub-border-style'], 'outline-and-shadow');
  assert.equal(o['sub-back-color'], '#00000000');
  assert.equal(o['sub-margin-y'], String(Math.round(0.06 * 720)));
  assert.equal(o['sub-delay'], '1.25');
  const box = mpvSubtitleOptions({ ...DEFAULT_SUBTITLE_PREFS, background: 'box', bgOpacity: 0.75, respectAss: false, font: 'system' });
  assert.equal(box['sub-ass-override'], 'force');
  assert.equal(box['sub-border-style'], 'background-box');
  assert.equal(box['sub-back-color'], '#BF000000');
  assert.equal(box['sub-font'], 'Helvetica Neue');
  for (const k of Object.keys(o)) assert.ok(k.startsWith('sub-'), k);
});

test('styled ASS is drawn by libass when the file style is kept, the overlay otherwise', () => {
  const ass = parseSubtitleText(readFileSync(new URL('../../../../subtitles/__tests__/fixtures/fansub.ass', import.meta.url), 'utf8'));
  const srt = parseSubtitleText('1\n00:00:01,000 --> 00:00:02,000\nSalut\n');
  assert.ok(libassRenders(ass, DEFAULT_SUBTITLE_PREFS));
  assert.ok(!libassRenders(ass, { ...DEFAULT_SUBTITLE_PREFS, respectAss: false }));
  assert.ok(!libassRenders(srt, DEFAULT_SUBTITLE_PREFS));
  assert.ok(!libassRenders(null, DEFAULT_SUBTITLE_PREFS));
});
