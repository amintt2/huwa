// Demo fixture for the bridge across seasons: a fictional season 2 of "Echo of the Void"
// (DEMO_SERIES in data/catalog.ts). It is not in the home rails, only reachable by id
// (`-HuwaRoute /anime/void2`). Season 1 adapts ch. 1–57 (exact demo data), so season 2 starts
// at ch. 58; it has no manhwa link of its own and inherits season 1's (data/mapping-overlay.ts).
import { makeEpisodes, type Series } from '@/data/catalog';

export const DEMO_SEASONS: Series[] = [
  {
    id: 'void2',
    title: 'Echo of the Void',
    synopsis: 'Rin a choisi la vérité. La ville basse, elle, n’a pas fini de payer le prix du signal.',
    genres: ['Action', 'Fantasy'],
    year: 2026,
    rating: 9.1,
    palette: ['#1B1147', '#7C6CFF', '#FF7A5C'],
    author: 'Han Seo-rin • Studio Arc',
    status: 'ongoing',
    anime: { episodes: makeEpisodes('void2', 12, 12) },
    estimated: true,
  },
];

/** Demo franchise chains: series id → earlier seasons, first season first. */
export const DEMO_CHAINS: Record<string, string[]> = { void2: ['void'] };
