// Community consensus on episode ↔ chapter corrections (pure, unit-tested).
// Every reader computes it locally from the signed proposals of the mapping room: nothing is
// trusted from the network but the signatures. Sybil / troll resistance:
//   - one active proposal per author and field (the newest replaces the older ones),
//   - each author weighs by the rank recomputed from their journal, capped, new keys weigh little,
//   - authors I block (or hidden by my lists) are ignored,
//   - a value is verified only with enough distinct authors, enough weight and a clear majority.
import { tierOf } from './rank';

export type Vote<V> = { author: string; field: string; value: V; key: string; ts: number };

export type ConsensusRules = {
  /** Distinct authors behind the leading value. */
  minAuthors: number;
  /** Total weight behind the leading value. */
  minWeight: number;
  /** Share of the weight of every (valid, unblocked) vote on the field. */
  majority: number;
  /** Maximum weight of a single author. */
  cap: number;
};

export const CONSENSUS_RULES: ConsensusRules = { minAuthors: 3, minWeight: 1.5, majority: 2 / 3, cap: 1 };

/** Weight by rank tier (Novice … Légende): a fresh identity counts for a tenth of a regular. */
const TIER_WEIGHT = [0.1, 0.3, 0.5, 0.7, 0.85, 1, 1];

/**
 * Weight of an author. `xp`: rank recomputed from their journal (undefined: not loaded yet,
 * counts as a new identity). Someone I follow is trusted a little more.
 */
export function authorWeight({ xp, followed = false }: { xp?: number; followed?: boolean }, rules = CONSENSUS_RULES): number {
  const base = xp === undefined ? TIER_WEIGHT[0] : TIER_WEIGHT[tierOf(xp).tierIndex] ?? TIER_WEIGHT[0];
  return Math.min(rules.cap, followed ? Math.max(base, 0.6) : base);
}

/** Newest vote per (author, field). Ties on the timestamp: highest value key, for determinism. */
export function latestPerAuthor<V>(votes: Vote<V>[]): Vote<V>[] {
  const latest = new Map<string, Vote<V>>();
  for (const v of votes) {
    const k = `${v.author}\u0000${v.field}`;
    const prev = latest.get(k);
    if (!prev || v.ts > prev.ts || (v.ts === prev.ts && v.key > prev.key)) latest.set(k, v);
  }
  return [...latest.values()];
}

export type Tally<V> = {
  /** Most supported value (by weight, then by authors, then by key). */
  leader?: { value: V; key: string; weight: number; authors: string[] };
  /** Weight of every counted vote on the field. */
  total: number;
  verified: boolean;
};

export type TallyOptions<V> = {
  weightOf: (author: string) => number;
  /** Ignored authors (blocks, lists). */
  blocked?: Set<string>;
  /** Values that do not fit the series are not counted. */
  valid?: (value: V) => boolean;
  rules?: ConsensusRules;
};

/** Tally the votes of one field (all with the same `field`). */
export function tally<V>(votes: Vote<V>[], { weightOf, blocked, valid, rules = CONSENSUS_RULES }: TallyOptions<V>): Tally<V> {
  const groups = new Map<string, { value: V; key: string; weight: number; authors: string[] }>();
  let total = 0;
  for (const v of latestPerAuthor(votes)) {
    if (blocked?.has(v.author)) continue;
    if (valid && !valid(v.value)) continue;
    const w = Math.max(0, Math.min(rules.cap, weightOf(v.author)));
    total += w;
    const g = groups.get(v.key) ?? { value: v.value, key: v.key, weight: 0, authors: [] };
    g.weight += w;
    g.authors.push(v.author);
    groups.set(v.key, g);
  }
  const leader = [...groups.values()].sort(
    (a, b) => b.weight - a.weight || b.authors.length - a.authors.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )[0];
  if (leader) leader.authors.sort();
  const verified =
    !!leader &&
    leader.authors.length >= rules.minAuthors &&
    leader.weight >= rules.minWeight - 1e-9 &&
    leader.weight >= total * rules.majority - 1e-9;
  return { leader, total, verified };
}

/** Group votes by field and tally each one. */
export function tallyAll<V>(votes: Vote<V>[], opts: TallyOptions<V>): Map<string, Tally<V>> {
  const byField = new Map<string, Vote<V>[]>();
  for (const v of votes) byField.set(v.field, [...(byField.get(v.field) ?? []), v]);
  const out = new Map<string, Tally<V>>();
  for (const [field, list] of byField) out.set(field, tally(list, opts));
  return out;
}
