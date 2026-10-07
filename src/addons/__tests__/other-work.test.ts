/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { otherWork } from '../other-work';

const s = (title: string) => ({ name: 'Torrentio', title });
const op1 = { startYear: 1999, episode: 1 };

test('One Piece episode 1: the live action and One Pace are another work, anime releases stay', () => {
  assert.equal(otherWork(s('One Piece S01E01 2023 2160p NF WEB-DL DDP5 1 Atmos DV HDR H 265-HHWEB'), op1), 'year');
  assert.equal(otherWork(s('ONE PIECE 2023 S01E01 Romance Dawn REPACK 1080p NF WEB-DL'), op1), 'year');
  assert.equal(otherWork(s('[One Pace][1-7] Romance Dawn [1080p]'), op1), 'fan-edit');
  assert.equal(otherWork(s('[Feibanyama] One Piece EP0001 [IQIYI WebRip 2160p HEVC OPUS]'), op1), null);
  assert.equal(otherWork(s('[Lia] One Piece - 0001-1000 [WEB-DL 1080p] [BATCH]'), op1), null);
  assert.equal(otherWork(s('[Anime Time] One Piece (0001-1071+Movies+Specials) [BD+CR] [1080p]'), op1), null);
  assert.equal(otherWork(s('One Piece (1999) E001 1080p'), op1), null);
});

test('episode range ends and resolutions are not years', () => {
  assert.equal(otherWork(s('Show 01~2000 batch'), { startYear: 2015, episode: 3 }), null);
});

test('a long-runner episode may carry its own air year', () => {
  assert.equal(otherWork(s('One Piece - 1085 (2023) [1080p]'), { startYear: 1999, episode: 1085 }), null);
  assert.equal(otherWork(s('One Piece - 1085 (2023) [1080p]'), { startYear: 1999, episode: 1085, episodeYear: 2023 }), null);
  assert.equal(otherWork(s('Frieren S01E05 2023 1080p'), { startYear: 2023, episode: 5 }), null);
  assert.equal(otherWork(s('Frieren S01E05 2031 Live Action'), { startYear: 2023, episode: 5 }), 'year');
});
