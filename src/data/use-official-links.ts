// Official services of a series (data/official-links.ts), cached like an opened series.
import { fetchOfficialLinks, type OfficialLinks } from './official-links';
import { TTL, useSwr } from './swr';

export function useOfficialLinks(anilistId: number | undefined) {
  return useSwr<OfficialLinks>(anilistId ? `official-links/${anilistId}` : null, () => fetchOfficialLinks(anilistId!), TTL.series);
}
