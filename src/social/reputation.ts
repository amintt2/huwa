// Local reputation (PLAN §6): simplified EigenTrust limited to 2 hops from *me*.
// Trust flows only along follows starting from my own key (and the labelers I subscribe
// to), so keys with no path to me weigh ~0: sybil farms stay invisible outside their circle.

export type TrustGraph = Record<string, { follows?: string[]; blocks?: string[] }>;

export type ReputationOptions = {
  /** Share of trust kept at hop 1 vs propagated to hop 2. */
  hop1Weight?: number;
  /** Extra trusted roots beside me (subscribed labelers), with a lower weight. */
  roots?: string[];
  rootWeight?: number;
};

/**
 * Returns a score in [0, 1] per reachable key (me excluded). Directly blocked keys get 0;
 * a key blocked by several of my follows is dampened proportionally.
 */
export function reputation(me: string, graph: TrustGraph, opts: ReputationOptions = {}): Record<string, number> {
  const { hop1Weight = 0.6, roots = [], rootWeight = 0.5 } = opts;
  const raw = new Map<string, number>();
  const add = (k: string, v: number) => raw.set(k, (raw.get(k) ?? 0) + v);

  const sources: [string, number][] = [[me, 1], ...roots.filter((r) => r !== me).map((r) => [r, rootWeight] as [string, number])];
  for (const [src, w] of sources) {
    const f1 = [...new Set(graph[src]?.follows ?? [])].filter((k) => k !== src);
    if (!f1.length) continue;
    for (const a of f1) {
      add(a, (w * hop1Weight) / f1.length);
      const f2 = [...new Set(graph[a]?.follows ?? [])].filter((k) => k !== a);
      for (const b of f2) add(b, (w * (1 - hop1Weight)) / (f1.length * f2.length));
    }
  }

  const myFollows = graph[me]?.follows ?? [];
  const myBlocks = new Set(graph[me]?.blocks ?? []);
  const blockedBy = new Map<string, number>();
  for (const f of myFollows) for (const b of graph[f]?.blocks ?? []) blockedBy.set(b, (blockedBy.get(b) ?? 0) + 1);

  const total = sources.reduce((s, [, w]) => s + w, 0);
  const out: Record<string, number> = {};
  for (const [k, v] of raw) {
    if (k === me) continue;
    if (myBlocks.has(k)) {
      out[k] = 0;
      continue;
    }
    const damp = myFollows.length ? 1 - Math.min(1, (blockedBy.get(k) ?? 0) / myFollows.length) : 1;
    out[k] = Math.min(1, (v / total) * damp);
  }
  return out;
}

/** Weighted vote count: each voter counts for its reputation (unknown keys ≈ 0, me = 1). */
export function weightedVotes(voters: string[], rep: Record<string, number>, me?: string, floor = 0.01): number {
  let sum = 0;
  for (const v of new Set(voters)) sum += v === me ? 1 : Math.max(floor, rep[v] ?? 0);
  return sum;
}
