// Which episode the pre-search runs for (see ./presearch.tsx), without React (unit-tested).
// - Focused screens propose a target; the highest priority wins (detail page > "Reprendre" row >
//   home hero), the most recent on a tie.
// - Mounted screens also "park" their target, focused or not: a series page covered by the add
//   sheet keeps it. When an addon becomes usable and no screen is searching that episode, the
//   parked series page gets an immediate warm-up (the new addon's sources are asked at once,
//   the others' answers are reused), for `WARMUP_MS`.
import { aggregateBase, episodeInUse } from '@/addons/agg-jobs';
import { onAddonsAdded } from '@/addons/addon-store';

export type PresearchTarget = {
  seriesId: string;
  /** Episode id (watch route), episode number. */
  episodeId: string;
  episode: number;
  /** Shown by the system media controls once the warm player is taken over. */
  meta?: { title?: string; artist?: string; artwork?: string };
};

export const PRIORITY = { hero: 1, continue: 2, detail: 3 } as const;

/** How long a new addon's warm-up keeps the pre-search of a covered series page running. */
export const WARMUP_MS = 90_000;
const WARMUP_OWNER = 'addon-warmup';

export type PresearchSlot = { target: PresearchTarget; priority: number; at: number };

const slots = new Map<string, PresearchSlot>();
const parked = new Map<string, PresearchSlot>();
const listeners = new Set<() => void>();
let winner: PresearchSlot | null = null;
let warmTimer: ReturnType<typeof setTimeout> | undefined;

const better = (s: PresearchSlot, best: PresearchSlot | null) => !best || s.priority > best.priority || (s.priority === best.priority && s.at > best.at);

function pickWinner() {
  let best: PresearchSlot | null = null;
  for (const s of slots.values()) if (better(s, best)) best = s;
  if (best?.target.episodeId === winner?.target.episodeId && best?.priority === winner?.priority) return;
  winner = best;
  listeners.forEach((l) => l());
}

export function subscribeWinner(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
export const getWinner = () => winner;

/** A focused screen proposes `target`. */
export function propose(owner: string, target: PresearchTarget, priority: number) {
  slots.set(owner, { target, priority, at: Date.now() });
  pickWinner();
}

/** Withdraws `owner`'s proposal, if it is still for `episodeId`. */
export function withdraw(owner: string, episodeId: string) {
  if (slots.get(owner)?.target.episodeId !== episodeId) return;
  slots.delete(owner);
  pickWinner();
}

/** A mounted screen's target, focused or not. */
export function park(owner: string, target: PresearchTarget, priority: number) {
  parked.set(owner, { target, priority, at: Date.now() });
}

export function unpark(owner: string, episodeId: string) {
  if (parked.get(owner)?.target.episodeId !== episodeId) return;
  parked.delete(owner);
  // The series page is gone: its warm-up too.
  if (![...parked.values()].some((s) => s.target.episodeId === episodeId)) withdraw(WARMUP_OWNER, episodeId);
}

const searched = (t: PresearchTarget) => episodeInUse(aggregateBase('stream', '', t.seriesId, t.episode));

/**
 * An addon became usable: the series page still open (possibly under the add sheet) has the
 * sources of its episode searched right away, unless a screen already searches that episode
 * (it re-queries the new addon itself). Returns the warmed-up target.
 */
export function warmUpNewAddon(inUse: (t: PresearchTarget) => boolean = searched): PresearchTarget | null {
  let best: PresearchSlot | null = null;
  for (const s of parked.values()) if (s.priority >= PRIORITY.detail && better(s, best)) best = s;
  if (!best || inUse(best.target)) return null;
  const { target } = best;
  slots.set(WARMUP_OWNER, { target, priority: best.priority, at: Date.now() });
  pickWinner();
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => withdraw(WARMUP_OWNER, target.episodeId), WARMUP_MS);
  return target;
}

onAddonsAdded(() => {
  warmUpNewAddon();
});

/** Test helper. */
export function resetPresearchTargets() {
  slots.clear();
  parked.clear();
  winner = null;
  clearTimeout(warmTimer);
}
