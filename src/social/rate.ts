// Deterministic posting rate (PLAN §3): a writer's declared timestamps must respect a
// minimum interval and an hourly quota. Same rule for the author (before sending) and for
// peers (when applying), so the check never depends on a wall clock other than `ts`.

export const RATE = { minIntervalMs: 15_000, perHour: 30 } as const;

/** 0 when a message at `ts` is allowed, otherwise how many ms to wait. */
export function rateWait(previous: number[], ts: number, rule: { minIntervalMs: number; perHour: number } = RATE): number {
  const sorted = previous.filter((t) => t <= ts).sort((a, b) => b - a);
  const last = sorted[0];
  let wait = last != null ? Math.max(0, last + rule.minIntervalMs - ts) : 0;
  const inHour = sorted.filter((t) => t > ts - 3_600_000);
  if (inHour.length >= rule.perHour) wait = Math.max(wait, inHour[rule.perHour - 1] + 3_600_000 - ts);
  return wait;
}
