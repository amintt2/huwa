// Episode ↔ chapter layout of a whole franchise (pure, no I/O: unit-tested in __tests__/mapping).
// Each AniList season is its own series, so the chapters a season adapts start right after what
// the previous seasons covered. Inputs per season, in franchise order:
//   - exact ranges from the provider (demo data, a real source): used as they are,
//   - community consensus (src/social/consensus.ts): a season end and/or pinned episodes,
//   - otherwise the estimate (~2.4 chapters per episode).

export const CHAPTERS_PER_EPISODE = 2.4;
/** Sane chapters-per-episode bounds for a correction. */
export const RATIO_MIN = 0.2;
export const RATIO_MAX = 12;
/** One episode adapts at most this many chapters. */
export const MAX_CHAPTERS_PER_EPISODE = 12;
export const MAX_CHAPTER = 20000;
/** Estimates stop this many chapters before the end of a known manhwa (the story goes on). */
const ESTIMATE_MARGIN = 5;

export type Range = readonly [number, number];

/** Community values for one season (only verified ones reach the layout). */
export type MappingOverride = {
  /** Last chapter adapted by the season. */
  end?: number;
  /** Episode number → chapters it adapts. */
  eps?: Record<number, Range>;
};

export type SeasonSpec = {
  id: string;
  episodes: number;
  /** Exact ranges from the provider: used as they are when no override exists. */
  fixed?: readonly Range[];
  override?: MappingOverride;
};

export type LayoutSource = 'estimate' | 'source' | 'verified';

export type SeasonLayout = {
  id: string;
  ranges: Range[];
  /** Chapters covered by the previous seasons (the season starts at `after + 1`). */
  after: number;
  /** Last chapter adapted by the season (`after` when it has no episode). */
  end: number;
  source: LayoutSource;
  /** Per episode: its range is known (provider data or pinned by the community). */
  exact: boolean[];
};

export const estimateCoverage = (episodes: number) => Math.max(1, Math.round(episodes * CHAPTERS_PER_EPISODE));

const isInt = (n: unknown): n is number => Number.isInteger(n);

/**
 * Spread `count` episodes evenly over chapters `after + 1 … end`. With fewer chapters than
 * episodes, consecutive episodes share a chapter; ranges never go backwards.
 */
export function spread(count: number, after: number, end: number): Range[] {
  const total = end - after;
  const out: Range[] = [];
  for (let i = 0; i < count; i++) {
    if (total <= 0) {
      const c = Math.max(1, end);
      out.push([c, c]);
      continue;
    }
    const from = after + Math.floor((i * total) / count) + 1;
    const to = after + Math.floor(((i + 1) * total) / count);
    out.push([from, Math.max(to, from)]);
  }
  return out;
}

/** Pins that keep the season monotonic, earliest episodes first (later conflicting ones dropped). */
export function consistentPins(n: number, eps: Record<number, Range> | undefined, end?: number): [number, Range][] {
  const sorted = Object.entries(eps ?? {})
    .map(([k, r]) => [Number(k), r] as [number, Range])
    .filter(([k, r]) => isInt(k) && k >= 1 && k <= n && isInt(r[0]) && isInt(r[1]) && r[0] >= 1 && r[0] <= r[1])
    .filter(([, r]) => end === undefined || r[1] <= end)
    .sort((a, b) => a[0] - b[0]);
  const kept: [number, Range][] = [];
  for (const [k, r] of sorted) {
    const prev = kept[kept.length - 1];
    if (prev) {
      const [pk, pr] = prev;
      // Adjacent episodes may share a chapter; with episodes in between, they need room.
      const ok = k === pk + 1 ? r[0] >= pr[1] && r[1] >= pr[1] : r[0] > pr[1];
      if (!ok) continue;
    }
    kept.push([k, r]);
  }
  return kept;
}

/** Ranges of one season from its start, its end and the pinned episodes (interpolated between). */
export function layoutSeason(n: number, after: number, end: number, pins: [number, Range][]): Range[] {
  if (n <= 0) return [];
  const knots: { i: number; c: number }[] = [];
  let start = after;
  if (pins.length) {
    const [k1, r1] = pins[0];
    start = k1 === 1 ? r1[0] - 1 : Math.min(after, r1[0] - 1);
    const [kl, rl] = pins[pins.length - 1];
    end = kl === n ? rl[1] : Math.max(end, rl[1]);
  }
  knots.push({ i: 0, c: Math.max(0, start) });
  for (const [k, r] of pins) {
    knots.push({ i: k - 1, c: r[0] - 1 }, { i: k, c: r[1] });
  }
  knots.push({ i: n, c: end });

  const out: Range[] = [];
  for (let j = 1; j < knots.length; j++) {
    const a = knots[j - 1];
    const b = knots[j];
    const count = b.i - a.i;
    if (count <= 0) continue;
    out.push(...spread(count, a.c, Math.max(a.c, b.c)));
  }
  return out.slice(0, n);
}

/**
 * Lay out a franchise, first season first. `knownTotal`: chapter count of the manhwa when it is
 * known (caps the estimates, never the provider or community values).
 */
export function chainLayout(seasons: SeasonSpec[], knownTotal?: number): SeasonLayout[] {
  let after = 0;
  const out: SeasonLayout[] = [];
  for (const s of seasons) {
    const n = Math.max(0, s.episodes);
    const o = s.override;
    const hasOverride = !!o && (o.end !== undefined || Object.keys(o.eps ?? {}).length > 0);
    let ranges: Range[];
    let source: LayoutSource;
    let exact: boolean[];

    if (!hasOverride && s.fixed && s.fixed.length === n && n > 0) {
      ranges = s.fixed.map((r) => [r[0], r[1]] as Range);
      source = 'source';
      exact = ranges.map(() => true);
    } else if (n === 0) {
      ranges = [];
      source = hasOverride ? 'verified' : 'estimate';
      exact = [];
    } else {
      let end: number;
      let start = after;
      if (o?.end !== undefined) {
        end = o.end;
        // The previous seasons are estimates that overshoot: trust the verified end.
        if (end <= start) start = Math.max(0, end - estimateCoverage(n));
      } else if (s.fixed && s.fixed.length === n) {
        end = s.fixed[n - 1][1];
      } else {
        end = after + estimateCoverage(n);
        if (knownTotal) end = Math.min(end, Math.max(after + 1, knownTotal - ESTIMATE_MARGIN), Math.max(knownTotal, after));
      }
      const pins = consistentPins(n, o?.eps, o?.end);
      ranges = layoutSeason(n, start, end, pins);
      const pinned = new Set(pins.map(([k]) => k));
      exact = ranges.map((_, i) => pinned.has(i + 1));
      source = hasOverride ? 'verified' : 'estimate';
    }
    out.push({ id: s.id, ranges, after, end: ranges.length ? ranges[ranges.length - 1][1] : after, source, exact });
    if (ranges.length) after = ranges[ranges.length - 1][1];
  }
  return out;
}

// ---------- corrections ----------

export type ProposalValue = { field: 'end'; to: number } | { field: 'ep'; ep: number; from: number; to: number };

export type SeasonContext = {
  /** Episodes of the season. */
  episodes: number;
  /** Chapters covered by the previous seasons. */
  after: number;
  /** `after` only comes from exact or verified data (otherwise it is an estimate). */
  afterReliable: boolean;
  /** Episodes of the previous seasons (ratio check when `after` is an estimate). */
  priorEpisodes: number;
  /** Chapter count of the manhwa when known. */
  knownTotal?: number;
};

/** Why a correction is refused (French, shown as is), or null when it is acceptable. */
export function validateProposal(p: ProposalValue, ctx: SeasonContext): string | null {
  const n = ctx.episodes;
  if (n <= 0) return 'Cette saison n’a pas encore d’épisode.';
  const max = ctx.knownTotal ?? MAX_CHAPTER;
  if (p.field === 'end') {
    const end = p.to;
    if (!isInt(end) || end < 1) return 'Indique un numéro de chapitre.';
    if (end > max) return `Le manhwa compte ${max} chapitres.`;
    if (ctx.afterReliable) {
      if (end <= ctx.after) return `Les saisons précédentes vont déjà jusqu’au ch. ${ctx.after}.`;
      const ratio = (end - ctx.after) / n;
      if (ratio < RATIO_MIN) return 'Trop peu de chapitres pour autant d’épisodes.';
      if (ratio > RATIO_MAX) return 'Trop de chapitres pour autant d’épisodes.';
    } else {
      const ratio = end / (ctx.priorEpisodes + n);
      if (ratio < RATIO_MIN) return 'Trop peu de chapitres pour toute la série.';
      if (ratio > RATIO_MAX) return 'Trop de chapitres pour toute la série.';
    }
    return null;
  }
  if (!isInt(p.ep) || p.ep < 1 || p.ep > n) return `Choisis un épisode entre 1 et ${n}.`;
  if (!isInt(p.from) || !isInt(p.to) || p.from < 1) return 'Indique des numéros de chapitre.';
  if (p.from > p.to) return 'Le premier chapitre doit précéder le dernier.';
  if (p.to - p.from + 1 > MAX_CHAPTERS_PER_EPISODE) return `Un épisode adapte au plus ${MAX_CHAPTERS_PER_EPISODE} chapitres.`;
  if (p.to > max) return `Le manhwa compte ${max} chapitres.`;
  if (ctx.afterReliable && p.from < ctx.after) return `Les saisons précédentes vont déjà jusqu’au ch. ${ctx.after}.`;
  return null;
}

/** Stable key of a proposal's value (equal proposals vote together). */
export const valueKey = (p: ProposalValue) => (p.field === 'end' ? `${p.to}` : `${p.from}-${p.to}`);
/** Field a proposal votes on inside its season. */
export const fieldKey = (p: Pick<ProposalValue, 'field'> & { ep?: number }) => (p.field === 'end' ? 'end' : `ep:${p.ep}`);
