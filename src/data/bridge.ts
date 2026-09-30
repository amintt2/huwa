// Anime ↔ manhwa mapping: the heart of the "continue in the other format" feature.
import type { Chapter, Episode, Series } from './catalog';

/** Last manhwa chapter covered by the anime (0 when there is no anime). */
export function animeEndChapter(s: Series) {
  const eps = s.anime?.episodes;
  return eps?.length ? eps[eps.length - 1].chapters[1] : 0;
}

/** Episode that adapts a given chapter, if any. */
export function episodeForChapter(s: Series, chapterNumber: number): Episode | undefined {
  return s.anime?.episodes.find(
    (e) => chapterNumber >= e.chapters[0] && chapterNumber <= e.chapters[1],
  );
}

/** First chapter to read after watching an episode (the story right after it). */
export function chapterAfterEpisode(s: Series, ep: Episode): Chapter | undefined {
  return s.manhwa?.chapters.find((c) => c.number === ep.chapters[1] + 1);
}

/** Chapter where the manhwa picks up once the anime is over. */
export function continuationChapter(s: Series): Chapter | undefined {
  return s.manhwa?.chapters.find((c) => c.number === animeEndChapter(s) + 1);
}

export const hasBoth = (s: Series) => !!s.anime && !!s.manhwa;

export const chapterRangeLabel = (ep: Episode) =>
  ep.chapters[0] === ep.chapters[1] ? `ch. ${ep.chapters[0]}` : `ch. ${ep.chapters[0]}–${ep.chapters[1]}`;

type Watched = Record<string, { done: boolean; updatedAt: number }>;

/** Episode to resume: the one you were last on, or the next one if you finished it. */
export function resumeEpisode(s: Series, watched: Watched): Episode | undefined {
  const eps = s.anime?.episodes ?? [];
  const touched = eps.filter((e) => watched[e.id]);
  if (!touched.length) return eps[0];
  const last = touched.reduce((a, b) => (watched[b.id].updatedAt > watched[a.id].updatedAt ? b : a));
  if (!watched[last.id].done) return last;
  return eps.find((e) => e.number === last.number + 1) ?? last;
}

/** Prefix for chapter numbers that are estimated rather than sourced. */
export const approx = (s: Series) => (s.estimated ? '≈ ' : '');
