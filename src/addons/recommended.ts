// Extensions Huwa can recommend: they serve metadata or subtitles only, never video content.
// Same list on the site (site/extensions.html). Content sources stay the user's choice.
export type Recommended = { url: string; name: string; what: string; icon: 'text-outline' | 'albums-outline' | 'film-outline' };

export const RECOMMENDED: Recommended[] = [
  {
    url: 'https://opensubtitles-v3.strem.io/manifest.json',
    name: 'OpenSubtitles',
    what: 'Sous-titres dans des dizaines de langues, pour chaque épisode.',
    icon: 'text-outline',
  },
  {
    url: 'https://anime-kitsu.strem.fun/manifest.json',
    name: 'Anime Kitsu',
    what: 'Catalogues anime, fiches détaillées et identifiants pour que tes autres extensions trouvent les épisodes.',
    icon: 'albums-outline',
  },
  {
    url: 'https://v3-cinemeta.strem.io/manifest.json',
    name: 'Cinemeta',
    what: 'Catalogues films et séries, et l’annuaire des addons publics.',
    icon: 'film-outline',
  },
];

export const EXTENSIONS_SITE = 'https://huwa.mciut.fr/extensions.html';
