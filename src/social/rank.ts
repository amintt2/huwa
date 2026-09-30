// Rank / XP replayed from a signed journal (PLAN §6). Every reader runs this same pure
// function on the author's journal: the rank shown is the one *recomputed by the viewer*,
// never a number the author claims. Plausibility caps make farming slow and visible.
import type { JournalEntry } from '../p2p/contract';

export type RankRules = {
  xp: { ep: number; ch: number; comment: number };
  /** Minimum minutes between two counted episodes (an episode lasts ~20 min). */
  epGapMin: number;
  epPerDay: number;
  chGapMin: number;
  chPerDay: number;
  commentPerDay: number;
  dailyXpCap: number;
  /** Declared timestamps must increase; small tolerance for clock jitter. */
  clockSkewMs: number;
  /** +1 % per 30 days of key age (first → last entry), up to this percentage. */
  seniorityMaxPct: number;
};

export const DEFAULT_RULES: RankRules = {
  xp: { ep: 10, ch: 4, comment: 2 },
  epGapMin: 20,
  epPerDay: 30,
  chGapMin: 2,
  chPerDay: 80,
  commentPerDay: 20,
  dailyXpCap: 400,
  clockSkewMs: 5 * 60_000,
  seniorityMaxPct: 20,
};

export const TIERS = [
  { min: 0, name: 'Novice' },
  { min: 100, name: 'Initié' },
  { min: 300, name: 'Habitué' },
  { min: 800, name: 'Passionné' },
  { min: 2000, name: 'Vétéran' },
  { min: 5000, name: 'Sensei' },
  { min: 12000, name: 'Légende' },
] as const;

export type RejectReason = 'doublon' | 'trop-rapide' | 'quota-jour' | 'plafond-xp' | 'horodatage' | 'futur' | 'invalide';
export type ScoredEntry = { entry: JournalEntry; xp: number; day: number };
export type RejectedEntry = { entry: JournalEntry; reason: RejectReason };

export type RankResult = {
  xp: number;
  baseXp: number;
  seniorityPct: number;
  level: number;
  tier: string;
  tierIndex: number;
  nextTier?: { name: string; min: number };
  /** 0..1 progress towards the next tier. */
  progress: number;
  accepted: ScoredEntry[];
  rejected: RejectedEntry[];
  counts: { ep: number; ch: number; comment: number };
  activeDays: number;
};

export const DAY = 86_400_000;
export const dayOf = (ts: number) => Math.floor(ts / DAY);

function isValid(e: JournalEntry): boolean {
  if (!e || typeof e.ts !== 'number' || !Number.isFinite(e.ts) || e.ts <= 0) return false;
  if (typeof e.work !== 'string' || !e.work || e.work.length > 64) return false;
  if (e.type === 'ep' || e.type === 'ch') return Number.isInteger(e.unit) && e.unit >= 0 && e.unit < 100_000;
  return e.type === 'comment';
}

export function tierOf(xp: number) {
  let i = 0;
  while (i + 1 < TIERS.length && xp >= TIERS[i + 1].min) i++;
  const next = TIERS[i + 1];
  const progress = next ? (xp - TIERS[i].min) / (next.min - TIERS[i].min) : 1;
  return { tierIndex: i, tier: TIERS[i].name, nextTier: next ? { name: next.name, min: next.min } : undefined, progress };
}

export const levelOf = (xp: number) => Math.floor(Math.sqrt(Math.max(0, xp) / 25)) + 1;

/**
 * Replay a journal in its (hash-chained) order. `now` only rejects entries dated in the
 * future; leave it undefined for a fully deterministic replay.
 */
export function replayJournal(journal: JournalEntry[], rules: RankRules = DEFAULT_RULES, now?: number): RankResult {
  const accepted: ScoredEntry[] = [];
  const rejected: RejectedEntry[] = [];
  const seen = new Set<string>();
  const perDay = new Map<string, number>();
  const xpPerDay = new Map<number, number>();
  const lastOf: Partial<Record<'ep' | 'ch', number>> = {};
  const counts = { ep: 0, ch: 0, comment: 0 };
  let lastTs = -Infinity;
  let baseXp = 0;

  for (const entry of journal) {
    if (!isValid(entry)) {
      rejected.push({ entry, reason: 'invalide' });
      continue;
    }
    if (now != null && entry.ts > now + rules.clockSkewMs) {
      rejected.push({ entry, reason: 'futur' });
      continue;
    }
    if (entry.ts < lastTs - rules.clockSkewMs) {
      rejected.push({ entry, reason: 'horodatage' });
      continue;
    }
    lastTs = Math.max(lastTs, entry.ts);
    const day = dayOf(entry.ts);

    if (entry.type !== 'comment') {
      const id = `${entry.type}:${entry.work}:${entry.unit}`;
      if (seen.has(id)) {
        rejected.push({ entry, reason: 'doublon' });
        continue;
      }
      const gap = entry.type === 'ep' ? rules.epGapMin : rules.chGapMin;
      const prev = lastOf[entry.type];
      if (prev != null && entry.ts - prev < gap * 60_000) {
        rejected.push({ entry, reason: 'trop-rapide' });
        continue;
      }
    }

    const quota = entry.type === 'ep' ? rules.epPerDay : entry.type === 'ch' ? rules.chPerDay : rules.commentPerDay;
    const dk = `${entry.type}:${day}`;
    const used = perDay.get(dk) ?? 0;
    if (used >= quota) {
      rejected.push({ entry, reason: 'quota-jour' });
      continue;
    }

    const dayXp = xpPerDay.get(day) ?? 0;
    const gain = Math.min(rules.xp[entry.type], rules.dailyXpCap - dayXp);
    if (gain <= 0) {
      rejected.push({ entry, reason: 'plafond-xp' });
      continue;
    }

    perDay.set(dk, used + 1);
    xpPerDay.set(day, dayXp + gain);
    if (entry.type !== 'comment') {
      seen.add(`${entry.type}:${entry.work}:${entry.unit}`);
      lastOf[entry.type] = entry.ts;
    }
    counts[entry.type]++;
    baseXp += gain;
    accepted.push({ entry, xp: gain, day });
  }

  const first = accepted[0]?.entry.ts;
  const last = accepted[accepted.length - 1]?.entry.ts;
  const ageDays = first != null && last != null ? (last - first) / DAY : 0;
  const seniorityPct = Math.min(rules.seniorityMaxPct, Math.floor(ageDays / 30));
  const xp = Math.round(baseXp * (1 + seniorityPct / 100));

  return {
    xp,
    baseXp,
    seniorityPct,
    level: levelOf(xp),
    ...tierOf(xp),
    accepted,
    rejected,
    counts,
    activeDays: xpPerDay.size,
  };
}

/** Longest and current run of consecutive active (UTC) days. */
export function streaks(days: number[], today?: number) {
  const set = [...new Set(days)].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  for (let i = 0; i < set.length; i++) {
    run = i > 0 && set[i] === set[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  let current = 0;
  if (set.length && (today == null || set[set.length - 1] >= today - 1)) {
    current = 1;
    for (let i = set.length - 1; i > 0 && set[i] === set[i - 1] + 1; i--) current++;
  }
  return { best, current };
}
