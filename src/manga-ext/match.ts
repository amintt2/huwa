// Title matching between a catalog series (AniList titles: english, romaji, native, synonyms) and
// the results of an installed source. Pure: no React Native import, unit-tested.

/** Lowercase, no accents, `&` → and, punctuation → spaces, bracketed notes and "the" dropped. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[([{【〔][^)\]}】〕]*(official|webtoon|manhwa|manhua|manga|novel|comic|remake|uncensored|raw)[^)\]}】〕]*[)\]}】〕]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[’'`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(the|a|an) /, '')
    .normalize('NFC');
}

const compact = (s: string) => normalizeForMatch(s).replace(/ /g, '');

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const chars = [...s];
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars[i] + chars[i + 1];
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice coefficient on character bigrams (0–1). */
function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let shared = 0;
  for (const [g, n] of A) shared += Math.min(n, B.get(g) ?? 0);
  return (2 * shared) / ([...a].length - 1 + [...b].length - 1);
}

/**
 * Similarity of two titles, 0–1. 1 = same title once normalized. A title contained in a longer
 * one ("Solo Leveling" ⊂ "Solo Leveling: Ragnarok") stays below the auto-link threshold: sequels
 * and spin-offs must not be linked automatically.
 */
export function titleSimilarity(a: string, b: string): number {
  const x = compact(a);
  const y = compact(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const contained = short.length >= 4 && long.includes(short) ? 0.7 + 0.2 * (short.length / long.length) : 0;
  return Math.min(0.99, Math.max(dice(x, y), contained));
}

/** Best similarity between any of our titles and any of the candidate's. */
export function bestTitleScore(ours: string[], theirs: string[]): number {
  let best = 0;
  for (const a of ours) for (const b of theirs) best = Math.max(best, titleSimilarity(a, b));
  return best;
}

export type SeriesTitles = {
  /** Titles in order of usefulness for a search: english, romaji, then synonyms and native. */
  titles: string[];
  /** Total chapters when AniList knows it (finished series). */
  chapters: number | null;
  finished: boolean;
};

/**
 * How believable a source's chapter count is for the series (0–1). A finished series with a
 * known count should have about that many chapters; ongoing series are not penalized.
 */
export function chapterPlausibility(target: Pick<SeriesTitles, 'chapters' | 'finished'>, found: number): number {
  if (found <= 0) return 0;
  if (!target.chapters || target.chapters <= 0) return 1;
  const ratio = found / target.chapters;
  if (ratio >= 0.8 && ratio <= 1.5) return 1;
  if (!target.finished && ratio > 1) return 1;
  if (ratio >= 0.5 && ratio <= 2.5) return 0.7;
  return 0.3;
}

/** Final score of a candidate: titles first, chapter count as a tie-breaker / sanity check. */
export function candidateScore(target: SeriesTitles, titles: string[], chapterCount?: number): number {
  const t = bestTitleScore(target.titles, titles);
  if (chapterCount === undefined) return t;
  return t * (0.85 + 0.15 * chapterPlausibility(target, chapterCount));
}

/** At or above: linked without asking. */
export const AUTO_LINK_SCORE = 0.9;
/** Below: not even proposed. */
export const MIN_CANDIDATE_SCORE = 0.5;

export type Candidate = { sourceKey: string; mangaId: string; title: string; altTitles?: string[]; chapters?: number; image?: string; subtitle?: string };
export type RankedCandidate = Candidate & { score: number };

/**
 * Ranks candidates from every source: best score first; on a tie, the source listed first in
 * `sourceOrder` (the user's priority) wins.
 */
export function rankCandidates(target: SeriesTitles, candidates: Candidate[], sourceOrder: string[] = []): RankedCandidate[] {
  const prio = (k: string) => {
    const i = sourceOrder.indexOf(k);
    return i < 0 ? sourceOrder.length : i;
  };
  return candidates
    .map((c) => ({ ...c, score: candidateScore(target, [c.title, ...(c.altTitles ?? [])], c.chapters) }))
    .filter((c) => c.score >= MIN_CANDIDATE_SCORE)
    .sort((a, b) => b.score - a.score || prio(a.sourceKey) - prio(b.sourceKey));
}

/**
 * Search queries to try on a source: distinct titles (by normalized form), latin first, at most
 * `max`. Native titles go last: few sources index them.
 */
export function searchQueries(titles: string[], max = 3): string[] {
  const seen = new Set<string>();
  const latin = (t: string) => /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]+$/u.test(t);
  const ordered = [...titles.filter(latin), ...titles.filter((t) => !latin(t))];
  const out: string[] = [];
  for (const t of ordered) {
    const k = compact(t);
    if (k.length < 2 || seen.has(k)) continue;
    seen.add(k);
    out.push(t.trim().slice(0, 120));
    if (out.length >= max) break;
  }
  return out;
}
