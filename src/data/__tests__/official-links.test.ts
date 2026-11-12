/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { episodeLink, languageLabel, officialSites, type ExternalLink } from '../official-links';

const link = (site: string, type: string, language: string | null, url = `https://${site.toLowerCase().replace(/\W/g, '')}.example/x`): ExternalLink =>
  ({ site, url, type, language, icon: null, color: null });

test('official services: streaming only, the user language first, one row per service', () => {
  const sites = officialSites(
    [
      link('Twitter', 'SOCIAL', 'English'),
      link('Official Site', 'INFO', 'Japanese'),
      link('Lezhin', 'STREAMING', 'German', 'https://delitoon.de/x'),
      link('Lezhin', 'STREAMING', 'French', 'https://delitoon.com/x'),
      link('Tapas', 'STREAMING', 'English'),
      link('Crunchyroll', 'STREAMING', null),
      link('Bad', 'STREAMING', null, 'javascript:alert(1)'),
    ],
    'fr',
  );
  assert.deepEqual(sites.map((s) => [s.site, s.language]), [['Lezhin', 'French'], ['Crunchyroll', null], ['Tapas', 'English']]);
  assert.equal(sites[0].url, 'https://delitoon.com/x');
});

test('direct episode link from "Episode N - Title", https only', () => {
  const eps = [
    { title: 'Episode 25 - On to the Next Target', url: 'http://www.crunchyroll.com/watch/G0D/next', site: 'Crunchyroll' },
    { title: 'Episode 2 - If I Had One More Chance', url: 'https://www.crunchyroll.com/watch/GX/chance', site: 'Crunchyroll' },
    { title: 'Special', url: 'https://x.example', site: 'Crunchyroll' },
  ];
  assert.deepEqual(episodeLink(eps, 25), { site: 'Crunchyroll', url: 'https://www.crunchyroll.com/watch/G0D/next', title: 'On to the Next Target' });
  assert.equal(episodeLink(eps, 2)?.title, 'If I Had One More Chance');
  assert.equal(episodeLink(eps, 3), undefined);
});

test('language label: hidden for the user language, in French otherwise', () => {
  assert.equal(languageLabel('French', 'fr'), undefined);
  assert.equal(languageLabel('English', 'fr'), 'anglais');
  assert.equal(languageLabel(null, 'fr'), undefined);
  assert.equal(languageLabel('Korean', 'en'), 'Korean');
});
