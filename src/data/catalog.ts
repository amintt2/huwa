// Catalog registry. At launch it holds the offline demo series below; `data/anilist.ts`
// then replaces them with the real trending anime / manhwa from AniList (posters, scores,
// airing schedule). Streams and pages stay placeholders until a licensed source is plugged in.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

export type Palette = readonly [string, string, string];

export type Episode = {
  id: string;
  seriesId: string;
  number: number;
  title: string;
  durationMin: number;
  /**
   * Official length per episode from AniList (minutes), when known. `durationMin` falls back to a
   * placeholder; this one is only set from real data (wrong-work check of the source controller).
   */
  officialMin?: number;
  /** Manhwa chapters adapted by this episode (inclusive). This powers the bridge. */
  chapters: readonly [number, number];
  videoUrl: string;
  /**
   * The range is approximate (spread between known season bounds). Undefined: same as the
   * series (`Series.estimated`).
   */
  estimated?: boolean;
};

export type Chapter = {
  id: string;
  seriesId: string;
  number: number;
  title: string;
  releasedDaysAgo: number;
  pageCount: number;
};

export type Series = {
  id: string;
  title: string;
  synopsis: string;
  genres: string[];
  year: number;
  rating: number;
  palette: Palette;
  author: string;
  status: 'ongoing' | 'completed' | 'upcoming';
  anime?: { episodes: Episode[] };
  manhwa?: { chapters: Chapter[] };
  /** Poster (portrait) and banner from the metadata provider. */
  image?: string;
  banner?: string;
  /** Next episode on the airing schedule (unix seconds). */
  nextAiring?: { episode: number; airingAt: number };
  /**
   * AniList id of the previous season (anime only): null when this is the first entry,
   * undefined when unknown (older cache, demo series). See `data/franchise.ts`.
   */
  prequel?: number | null;
  /** First air / publication date (YYYY-MM-DD) when the provider knows the day. */
  start?: string;
  /** Position in the provider's trending chart. */
  trendRank?: number;
  /** Episode ↔ chapter mapping is an estimate (no public source has exact data). */
  estimated?: boolean;
  /** AniList id of the manhwa paired with this series (the corrections room is keyed by it). */
  manhwaId?: number;
  /** The manhwa's chapter count is real (AniList count or a linked source), not a placeholder. */
  chaptersKnown?: boolean;
  /** Where the bridge numbers come from, filled by data/mapping-overlay.ts. */
  mapping?: MappingInfo;
  /** AniList country of origin of the anime (JP, KR, CN…): its original audio language. */
  origin?: string;
};

export type MappingInfo = {
  source: 'estimate' | 'source' | 'verified';
  /** 0 = first season of the franchise. */
  season: number;
  /** Chapters covered by the previous seasons, and the last chapter this season adapts. */
  after: number;
  end: number;
  /** `after` only comes from exact or verified numbers. */
  afterReliable: boolean;
  /** Episodes of the previous seasons. */
  priorEpisodes: number;
  /** Chapter count of the manhwa when it is real (not a placeholder list). */
  knownTotal?: number;
  /** P2P room where corrections for this manhwa are published. */
  room: string;
};

// Placeholder streams: Blender Foundation open movies (CC-BY) and Apple's HLS test stream.
const SAMPLE_VIDEOS = [
  'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4',
  'https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov',
  'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
];

const EP_TITLES = [
  'Le signal', 'Les anciennes lames', 'Ville basse', 'Serment de minuit', 'Poussière d’étoiles',
  'Le gardien', 'Sous la pluie', 'Échos', 'La porte close', 'Premier sang', 'Retour au quartier',
  'Masques', 'La faille', 'Le miroir brisé', 'Serment', 'Rivages', 'Le prix', 'Chute libre',
  'La voix', 'Racines', 'Deux lames', 'L’aube rouge', 'Le choix', 'Au-delà du vide',
];
const CH_TITLES = [
  'Le pacte', 'Réveil', 'La marque', 'Rencontre', 'Contre-jour', 'Le serment', 'Fracture',
  'La nuit longue', 'Traces', 'Brèche', 'Héritage', 'Le jardin', 'Marée haute', 'Silence',
];

export function makeEpisodes(seriesId: string, count: number, lastChapter: number, titled = true, officialMin?: number | null): Episode[] {
  const official = officialMin && officialMin > 0 ? officialMin : undefined;
  return Array.from({ length: count }, (_, i) => {
    const from = Math.floor((i * lastChapter) / count) + 1;
    const to = Math.floor(((i + 1) * lastChapter) / count);
    return {
      id: `${seriesId}-e${i + 1}`,
      seriesId,
      number: i + 1,
      title: titled ? EP_TITLES[i % EP_TITLES.length] : '',
      durationMin: official ?? 23 + (i % 2),
      ...(official ? { officialMin: official } : null),
      chapters: [from, to] as const,
      videoUrl: SAMPLE_VIDEOS[i % SAMPLE_VIDEOS.length],
    };
  });
}

export function makeChapters(seriesId: string, count: number, titled = true): Chapter[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${seriesId}-c${i + 1}`,
    seriesId,
    number: i + 1,
    title: titled ? CH_TITLES[i % CH_TITLES.length] : '',
    releasedDaysAgo: (count - i - 1) * 7,
    pageCount: 14 + ((i * 7) % 10),
  }));
}

/** Offline fallback: original placeholder series. */
export const DEMO_SERIES: Series[] = [
  {
    id: 'void',
    title: 'Echo of the Void',
    synopsis:
      'Quand un signal venu du néant réveille les anciennes lames, Rin doit choisir entre sa ville et la vérité sur sa famille.',
    genres: ['Action', 'Fantasy'],
    year: 2025,
    rating: 9.3,
    palette: ['#1B1147', '#7C6CFF', '#FF7A5C'],
    author: 'Han Seo-rin • Studio Arc',
    status: 'ongoing',
    anime: { episodes: makeEpisodes('void', 24, 57) },
    manhwa: { chapters: makeChapters('void', 142) },
  },
  {
    id: 'lotus',
    title: 'Iron Lotus',
    synopsis:
      'Une mécanicienne des bas-fonds hérite d’une armure vivante qui refuse d’obéir à qui que ce soit… sauf à elle.',
    genres: ['Mecha', 'Drame'],
    year: 2024,
    rating: 8.4,
    palette: ['#0F2A3F', '#2FB5A5', '#C9F27A'],
    author: 'Park Ji-an',
    status: 'ongoing',
    anime: { episodes: makeEpisodes('lotus', 12, 30) },
    manhwa: { chapters: makeChapters('lotus', 88) },
  },
  {
    id: 'ledger',
    title: 'Crimson Ledger',
    synopsis:
      'Chaque dette inscrite dans le registre écarlate se paie en souvenirs. Seo-yun a décidé de tout rembourser.',
    genres: ['Thriller', 'Surnaturel'],
    year: 2023,
    rating: 8.9,
    palette: ['#2A0A12', '#E0445B', '#FFC857'],
    author: 'Lee Dae-ho',
    status: 'ongoing',
    manhwa: { chapters: makeChapters('ledger', 140) },
  },
  {
    id: 'sky',
    title: 'Skybound Heir',
    synopsis:
      'Héritier d’une cité flottante en chute libre, Kaen a douze jours pour la ramener dans les nuages.',
    genres: ['Aventure', 'Fantasy'],
    year: 2025,
    rating: 9.1,
    palette: ['#0B1F4D', '#4DA3FF', '#E6F0FF'],
    author: 'Studio Kite',
    status: 'completed',
    anime: { episodes: makeEpisodes('sky', 12, 12) },
  },
  {
    id: 'garden',
    title: 'Night Garden',
    synopsis:
      'Un jardin qui ne fleurit que la nuit, une botaniste insomniaque et des visiteurs qui ne devraient pas exister.',
    genres: ['Mystère', 'Slice of life'],
    year: 2024,
    rating: 8.9,
    palette: ['#1A0F2E', '#B04FD1', '#FFB86B'],
    author: 'Yoon Ha-eun',
    status: 'ongoing',
    anime: { episodes: makeEpisodes('garden', 13, 40) },
    manhwa: { chapters: makeChapters('garden', 96) },
  },
  {
    id: 'tide',
    title: 'Tidebreaker',
    synopsis: 'Sur une île que la mer reprend chaque hiver, une équipe de plongeurs défie la marée.',
    genres: ['Sport', 'Aventure'],
    year: 2025,
    rating: 8.7,
    palette: ['#062A2F', '#1FA7C9', '#9DF0E0'],
    author: 'Choi Min',
    status: 'ongoing',
    anime: { episodes: makeEpisodes('tide', 10, 25) },
    manhwa: { chapters: makeChapters('tide', 60) },
  },
];

// ---------- registry ----------

let current: Series[] = DEMO_SERIES;
/**
 * Series opened from search, the calendar or an AniList import. They are not part of the
 * trending catalog (tabs, home rails) but must resolve by id — and survive restarts.
 */
let extras = new Map<string, Series>();
let byId = new Map(current.map((s) => [s.id, s]));
let version = 0;
const listeners = new Set<() => void>();

const EXTRA_KEY = 'huwa/catalog/extra/v1';
const MAX_EXTRAS = 400;

/**
 * Real chapter lists from a manga source (see src/manga-ext/link.ts), keyed by series id. They
 * replace the placeholder chapters of that series everywhere (detail page, reader, bridge).
 */
const chapterOverlays = new Map<string, Chapter[]>();

/**
 * Episodes out per series according to its full airing schedule (data/upcoming.ts): an episode
 * that airs after the catalog was fetched becomes playable, one announced but not aired yet is
 * not listed. Same count as the catalog (data/airing.ts `airedEpisodeCount`).
 */
const airedOverlays = new Map<string, number>();

function resizeEpisodes(episodes: Episode[], seriesId: string, count: number): Episode[] {
  if (count <= episodes.length) return episodes.slice(0, count);
  const last = episodes[episodes.length - 1];
  const more = makeEpisodes(seriesId, count, Math.max(count, last?.chapters[1] ?? 0), !!last?.title, last?.officialMin);
  return [...episodes, ...more.slice(episodes.length)];
}

function withOverlay(s: Series): Series {
  const chapters = chapterOverlays.get(s.id);
  let out = chapters ? { ...s, manhwa: { chapters }, chaptersKnown: true } : s;
  const aired = airedOverlays.get(s.id);
  if (aired && out.anime && aired !== out.anime.episodes.length) out = { ...out, anime: { episodes: resizeEpisodes(out.anime.episodes, s.id, aired) } };
  return out;
}

/** Episodes out per series (`seriesId → count`), from the airing schedule. Rebuilds once. */
export function setAiredCounts(counts: Record<string, number>) {
  let changed = false;
  for (const [id, n] of Object.entries(counts)) {
    if (n > 0 && airedOverlays.get(id) !== n) {
      airedOverlays.set(id, n);
      changed = true;
    }
  }
  if (changed) rebuildIndex();
}

/**
 * Last step of every lookup (see data/mapping-overlay.ts: franchise-wide chapter ranges and
 * community corrections). `base` resolves other series before the transform.
 */
export type SeriesTransform = (s: Series, base: (id: string) => Series | undefined) => Series;
let transform: SeriesTransform | null = null;

let currentView: Series[] = current;

function rebuildIndex() {
  const base = new Map([...extras.values(), ...current].map((s) => [s.id, withOverlay(s)]));
  const view = (s: Series) => (transform ? transform(s, (id) => base.get(id)) : s);
  byId = new Map([...base].map(([id, s]) => [id, view(s)]));
  currentView = current.map((s) => byId.get(s.id) ?? s);
  version++;
  listeners.forEach((l) => l());
}

export function setSeriesTransform(fn: SeriesTransform | null) {
  transform = fn;
  rebuildIndex();
}

/** Recompute every series (the inputs of the transform changed). */
export function refreshCatalog() {
  rebuildIndex();
}

export function setChapterOverlay(seriesId: string, chapters: Chapter[] | undefined) {
  if (chapters) chapterOverlays.set(seriesId, chapters);
  else chapterOverlays.delete(seriesId);
  rebuildIndex();
}

export function setCatalog(list: Series[]) {
  if (!list.length) return;
  current = list;
  rebuildIndex();
}

/** Add series found outside the trending catalog (search, calendar, import). Persisted. */
export function registerSeries(list: Series[]) {
  if (!list.length) return;
  for (const s of list) {
    extras.delete(s.id); // re-insert: most recent last
    extras.set(s.id, s);
  }
  while (extras.size > MAX_EXTRAS) extras.delete(extras.keys().next().value!);
  rebuildIndex();
  AsyncStorage.setItem(EXTRA_KEY, JSON.stringify([...extras.values()])).catch(() => {});
}

/** Restore registered series (called by `loadCatalog` before anything renders). */
export async function hydrateExtraSeries() {
  try {
    const raw = await AsyncStorage.getItem(EXTRA_KEY);
    if (!raw) return;
    const list = JSON.parse(raw) as Series[];
    extras = new Map(list.map((s) => [s.id, s]));
    rebuildIndex();
  } catch {
    // corrupted: start empty
  }
}

/** Re-render when the catalog is replaced (returns a version number). */
export function useCatalog() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => version,
  );
}

export const allSeries = () => currentView;
export const animeSeries = () => currentView.filter((s) => s.anime);
export const manhwaSeries = () => currentView.filter((s) => s.manhwa);
export const getSeries = (id: string) => byId.get(id);

export function getEpisode(id: string) {
  const seriesId = id.split('-e')[0];
  const series = byId.get(seriesId);
  const episode = series?.anime?.episodes.find((e) => e.id === id);
  return series && episode ? { series, episode } : undefined;
}

export function getChapter(id: string) {
  const seriesId = id.split('-c')[0];
  const series = byId.get(seriesId);
  const chapter = series?.manhwa?.chapters.find((c) => c.id === id);
  return series && chapter ? { series, chapter } : undefined;
}

/** Placeholder page images; swap for your CDN. */
export const pageUrl = (chapterId: string, index: number) =>
  `https://picsum.photos/seed/${chapterId}-${index}/800/1200`;
export const PAGE_ASPECT = 800 / 1200;

/** "Ép. 3 — Titre" or "Ép. 3" when the provider has no episode titles. */
export const episodeLabel = (e: Episode) => (e.title ? `Ép. ${e.number} — ${e.title}` : `Épisode ${e.number}`);
export const chapterLabel = (c: Chapter) => (c.title ? `Ch. ${c.number} — ${c.title}` : `Chapitre ${c.number}`);
