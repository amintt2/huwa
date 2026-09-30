/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAnimeSamaExport, parseAnimeSamaExport } from '../anime-sama';
import { parseStremioExport } from '../stremio';

test('Stremio export: library items and addons', () => {
  const exp = parseStremioExport({
    addons: {
      addons: [
        { transportUrl: 'https://v3-cinemeta.strem.io/manifest.json', flags: { official: true, protected: true } },
        { transportUrl: 'https://anime-kitsu.strem.fun/manifest.json', flags: {} },
        { transportUrl: 'http://127.0.0.1:11470/local-addon/manifest.json', flags: { protected: true } },
      ],
    },
    library: [
      { __id: '1', _id: 'kitsu:1', d: { _id: 'kitsu:1', name: 'Cowboy Bebop', type: 'series', removed: false, temp: false, state: { video_id: 'kitsu:1:5', timesWatched: 0 } } },
      { __id: '2', _id: 'tt8772296', d: { _id: 'tt8772296', name: 'Euphoria', type: 'series', removed: true, temp: false, state: { video_id: 'tt8772296:1:1' } } },
      { __id: '3', _id: 'kitsu:11', d: { _id: 'kitsu:11', name: 'Naruto', type: 'series', removed: false, temp: false, state: {} } },
      { __id: '4', _id: 'kitsu:7', d: { _id: 'kitsu:7', name: 'Akira', type: 'movie', removed: false, temp: false, state: { flaggedWatched: 1 } } },
      { __id: '5', _id: 'kitsu:9', d: { _id: 'kitsu:9', name: 'Temp', type: 'series', removed: false, temp: true, state: {} } },
    ],
  });
  assert.deepEqual(exp.addons, ['https://anime-kitsu.strem.fun/manifest.json']);
  assert.deepEqual(
    exp.items.map((i) => [i.id, i.status]),
    [['kitsu:1', 'CURRENT'], ['kitsu:11', 'PLANNING'], ['kitsu:7', 'COMPLETED']],
  );
});

test('anime-sama backup: columns are JSON strings, one entry per series', () => {
  const file = {
    _app: 'anime-sama',
    _type: 'sauvegarde-bibliotheque',
    _version: 1,
    data: {
      histoNom: JSON.stringify(['One Piece', 'Solo Leveling']),
      histoUrl: JSON.stringify(['https://anime-sama.to/catalogue/one-piece/saison1/vostfr/', 'https://anime-sama.to/catalogue/solo-leveling/scan/vf/']),
      histoEp: JSON.stringify(['Episode 1071', 'Chapitre 120']),
      watchlistNom: JSON.stringify(['Frieren', 'One Piece']),
      watchlistUrl: JSON.stringify(['https://anime-sama.to/catalogue/frieren/saison1/vostfr/', 'https://anime-sama.to/catalogue/one-piece/saison2/vf/']),
      vuNom: JSON.stringify(['']),
      vuUrl: JSON.stringify(['https://anime-sama.to/catalogue/death-note/saison1/vostfr/']),
      'savedEpNbhttps://anime-sama.to/catalogue/one-piece/saison1/vostfr/': '1071',
    },
  };
  assert.ok(isAnimeSamaExport(file));
  assert.ok(!isAnimeSamaExport({ library: [] }));
  const items = parseAnimeSamaExport(file);
  assert.deepEqual(
    items.map((i) => [i.title, i.status, i.manhwa, i.episode ?? null]),
    [
      ['death note', 'COMPLETED', false, null],
      ['One Piece', 'CURRENT', false, 1071],
      ['Solo Leveling', 'CURRENT', true, 120],
      ['Frieren', 'PLANNING', false, null],
    ],
  );
});
