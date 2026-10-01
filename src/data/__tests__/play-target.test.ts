/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Series } from '../catalog';
import { playTarget } from '../play-target';

const season = (id: string, count: number): Series => ({
  id,
  title: id,
  synopsis: '',
  genres: [],
  year: 2024,
  rating: 8,
  palette: ['#000000', '#000000', '#000000'],
  author: '',
  status: 'ongoing',
  anime: {
    episodes: Array.from({ length: count }, (_, i) => ({
      id: `${id}-e${i + 1}`,
      seriesId: id,
      number: i + 1,
      title: '',
      durationMin: 24,
      chapters: [i + 1, i + 1] as const,
      videoUrl: '',
    })),
  },
});

const s1 = season('al1', 12);
const s2 = season('al2', 12);
const s3 = season('al3', 10);
const p = (done: boolean, updatedAt: number) => ({ done, updatedAt });

test('never watched: first episode of the first season', () => {
  const t = playTarget([s1, s2, s3], {})!;
  assert.equal(t.episode.id, 'al1-e1');
  assert.equal(t.label, 'Regarder · S1 Ép. 1');
  assert.equal(t.started, false);
});

test('single season keeps the plain label', () => {
  assert.equal(playTarget([s3], {})!.label, 'Regarder · Ép. 1');
});

test('resumes the most recently watched season', () => {
  const t = playTarget([s1, s2, s3], { 'al1-e12': p(true, 1), 'al2-e4': p(false, 5), 'al2-e3': p(true, 4) })!;
  assert.equal(t.episode.id, 'al2-e4');
  assert.equal(t.label, 'Reprendre · S2 Ép. 4');
});

test('next episode after a finished one', () => {
  const t = playTarget([s1, s2, s3], { 'al2-e4': p(true, 5) })!;
  assert.equal(t.episode.id, 'al2-e5');
});

test('season finale moves on to the next season', () => {
  const t = playTarget([s1, s2, s3], { 'al1-e12': p(true, 9) })!;
  assert.equal(t.episode.id, 'al2-e1');
  assert.equal(t.season, 2);
});

test('last season finished: stays on its last episode', () => {
  const t = playTarget([s1, s2, s3], { 'al3-e10': p(true, 9) })!;
  assert.equal(t.episode.id, 'al3-e10');
});
