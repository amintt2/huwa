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

test('season model numbering: Final Season Part 2 is "S4", its episodes continue the season', () => {
  // AoT: S1, S2, S3, S3 Part 2, Final Season, Final Season Part 2 (6 AniList entries).
  const chain = ['al1', 'al2', 'al3', 'al4', 'al5', 'al6'].map((id) => season(id, 12));
  const grouped: Record<string, { season: number; from: number }> = {
    al1: { season: 1, from: 1 }, al2: { season: 2, from: 1 }, al3: { season: 3, from: 1 },
    al4: { season: 3, from: 13 }, al5: { season: 4, from: 1 }, al6: { season: 4, from: 13 },
  };
  const numbering = (id: string, n: number) => ({ season: grouped[id].season, shown: grouped[id].from + n - 1 });
  const watched = { 'al5-e12': p(true, 3) };
  assert.equal(playTarget(chain, watched)!.label, 'Reprendre · S6 Ép. 1', 'old count: one season per entry');
  const t = playTarget(chain, watched, numbering)!;
  assert.equal(t.episode.id, 'al6-e1');
  assert.equal(t.season, 4);
  assert.equal(t.label, 'Reprendre · S4 Ép. 13');
  // A lone season in the model: no season in the label.
  assert.equal(playTarget([s1, s2], {}, (_, n) => ({ shown: n }))!.label, 'Regarder · Ép. 1');
});
