// Real catalog metadata from AniList's public GraphQL API (https://docs.anilist.co).
// We only use metadata and image URLs served by their CDN; nothing is copied into the app.
// Episode ↔ chapter mapping is not published anywhere, so bridges on real series are estimates.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { makeChapters, makeEpisodes, setCatalog, type Palette, type Series } from './catalog';

const ENDPOINT = 'https://graphql.anilist.co';
const CACHE_KEY = 'huwa/catalog/v2';
const MAX_EPISODES = 200;

const NODE = `id type format status countryOfOrigin episodes chapters averageScore genres seasonYear
  title { english userPreferred } description(asHtml: false)
  coverImage { extraLarge color } bannerImage nextAiringEpisode { episode airingAt }`;

const QUERY = `query {
  anime: Page(perPage: 24) { media(type: ANIME, sort: TRENDING_DESC, isAdult: false) {
    ${NODE} relations { edges { relationType(version: 2) node { ${NODE} } } } } }
  manhwa: Page(perPage: 24) { media(type: MANGA, countryOfOrigin: KR, sort: TRENDING_DESC, isAdult: false) {
    ${NODE} relations { edges { relationType(version: 2) node { ${NODE} } } } } }
}`;

type Media = {
  id: number;
  type: 'ANIME' | 'MANGA';
  status: 'FINISHED' | 'RELEASING' | 'NOT_YET_RELEASED' | 'CANCELLED' | 'HIATUS' | null;
  countryOfOrigin: string | null;
  episodes: number | null;
  chapters: number | null;
  averageScore: number | null;
  genres: string[] | null;
  seasonYear: number | null;
  title: { english: string | null; userPreferred: string };
  description: string | null;
  coverImage: { extraLarge: string; color: string | null };
  bannerImage: string | null;
  nextAiringEpisode: { episode: number; airingAt: number } | null;
  relations?: { edges: { relationType: string; node: Media }[] };
};

// ---------- helpers ----------

const hexToRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbToHex = (c: number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const mix = (a: string, b: string, t: number) => {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex(x.map((v, i) => v + (y[i] - v) * t));
};
function palette(color: string | null): Palette {
  const c = color && /^#[0-9a-f]{6}$/i.test(color) ? color : '#2F6BEB';
  return [mix(c, '#05070D', 0.78), c, mix(c, '#FFFFFF', 0.35)];
}

const clean = (html: string | null) =>
  (html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, '’')
    .replace(/\(Source:[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

const title = (m: Media) => m.title.english ?? m.title.userPreferred;
const status = (m: Media): Series['status'] =>
  m.status === 'FINISHED' || m.status === 'CANCELLED' ? 'completed' : m.status === 'NOT_YET_RELEASED' ? 'upcoming' : 'ongoing';
const episodeCount = (m: Media) =>
  Math.min(MAX_EPISODES, m.episodes ?? (m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : 0));
const isManhwa = (m: Media) => m.type === 'MANGA' && m.countryOfOrigin === 'KR';

function build(anime: Media | null, manhwa: Media | null, trendRank: number): Series | null {
  const lead = anime ?? manhwa!;
  const id = anime ? `al${anime.id}` : `alm${manhwa!.id}`;
  const eps = anime ? episodeCount(anime) : 0;
  if (anime && eps === 0 && !manhwa) return null; // not aired yet, nothing to watch

  const chapterTotal = manhwa ? manhwa.chapters ?? 120 : 0;
  // Estimated coverage: ~2.4 chapters per episode, leaving the manhwa ahead of the anime.
  const covered = manhwa ? Math.max(1, Math.min(chapterTotal - 5, Math.round(eps * 2.4))) : eps;

  return {
    id,
    title: title(lead),
    synopsis: clean(lead.description) || clean(manhwa?.description ?? null),
    genres: (lead.genres ?? []).slice(0, 3),
    year: lead.seasonYear ?? 0,
    rating: (lead.averageScore ?? 0) / 10,
    palette: palette(lead.coverImage.color),
    author: manhwa ? `Manhwa · Corée du Sud` : 'Anime',
    status: status(lead),
    image: lead.coverImage.extraLarge,
    banner: lead.bannerImage ?? undefined,
    nextAiring: anime?.nextAiringEpisode ?? undefined,
    trendRank,
    estimated: !!(anime && manhwa),
    anime: anime && eps > 0 ? { episodes: makeEpisodes(id, eps, covered, false) } : undefined,
    manhwa: manhwa ? { chapters: makeChapters(id, chapterTotal, false) } : undefined,
  };
}

function mapCatalog(data: { anime: { media: Media[] }; manhwa: { media: Media[] } }): Series[] {
  const out: Series[] = [];
  const usedManhwa = new Set<number>();
  const usedAnime = new Set<number>();

  data.anime.media.forEach((a, i) => {
    const src = a.relations?.edges.find((e) => e.relationType === 'SOURCE' && isManhwa(e.node))?.node ?? null;
    const s = build(a, src, i + 1);
    if (!s) return;
    usedAnime.add(a.id);
    if (src) usedManhwa.add(src.id);
    out.push(s);
  });

  data.manhwa.media.forEach((m, i) => {
    if (usedManhwa.has(m.id)) return;
    const adaptation =
      m.relations?.edges.find((e) => e.relationType === 'ADAPTATION' && e.node.type === 'ANIME' && episodeCount(e.node) > 0)?.node ?? null;
    if (adaptation && usedAnime.has(adaptation.id)) return;
    const s = build(adaptation, m, i + 1);
    if (s) out.push(s);
  });
  return out;
}

async function fetchCatalog(): Promise<Series[]> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: QUERY }),
  });
  if (!res.ok) throw new Error(`AniList ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message ?? 'AniList error');
  return mapCatalog(json.data);
}

/**
 * Stale-while-revalidate: show the cached catalog instantly, refresh from the network,
 * keep the offline demo if both fail. Resolves once something real is on screen (or on failure).
 */
export async function loadCatalog(): Promise<void> {
  let hadCache = false;
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (raw) {
      setCatalog(JSON.parse(raw) as Series[]);
      hadCache = true;
    }
  } catch {
    // corrupted cache: ignore, the network refresh will overwrite it
  }

  const refresh = fetchCatalog()
    .then((list) => {
      if (!list.length) return;
      setCatalog(list);
      AsyncStorage.setItem(CACHE_KEY, JSON.stringify(list)).catch(() => {});
    })
    .catch(() => {
      // offline: keep cache or demo series
    });

  if (!hadCache) await refresh;
}
