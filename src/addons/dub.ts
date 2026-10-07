// Dub mode ("Doublés", Réglages → Langues) from A to Z: when to keep waiting for a dubbed source,
// when to tell the user there is none, what they chose for the episode, and what we remember of
// a series (an episode without dub makes the next ones likely without dub too).
// Pure functions + two small stores (choices per episode in memory, dub knowledge per series
// persisted). The source side lives in ./use-source.ts (it only spends race / torrent probes on
// dubbed candidates while any is alive), the screen side in app/watch/[id].tsx.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

/**
 *   off       not in dub mode (or nothing to say)
 *   dub       a dubbed (or maybe dubbed) candidate is in the running: play it
 *   searching no dubbed candidate yet, but addons are still answering / a track check runs
 *   missing   no dub for this episode: ask the user (popup), play nothing meanwhile
 *   fallback  no dub, and the user accepted another version (or the setting says so)
 *   empty     no source at all (the usual "no source" explanation applies)
 */
export type DubPhase = 'off' | 'dub' | 'searching' | 'missing' | 'fallback' | 'empty';

/** What the user chose for an episode without dub (asked once per episode). */
export type DubChoice = 'fallback' | 'menu' | 'back';

/** Longest wait for a dubbed source from slow addons before saying there is none. */
export const DUB_WAIT_MS = 8000;
/** The series is known to lack a dub from here: the popup comes once the first answers are in. */
export const KNOWN_NO_DUB_WAIT_MS = 1500;

export type DubPhaseInput = {
  dubMode: boolean;
  choice?: DubChoice;
  /** Réglages: play the best other version without asking. */
  autoFallback: boolean;
  /** Dubbed / maybe-dubbed candidates still alive (not dead, not verified without dub). */
  dubAlive: number;
  /** A track check that may still turn a candidate into a dub. */
  verifying: boolean;
  /** Addons that have not answered yet. */
  addonsPending: number;
  /** Since the search started (ms). */
  elapsedMs: number;
  knownNoDub: boolean;
  /** Playable candidates that are not dubbed (the other versions). */
  fallbacks: number;
};

export function dubPhase(i: DubPhaseInput): DubPhase {
  if (!i.dubMode) return 'off';
  if (i.dubAlive > 0) return 'dub';
  if (i.verifying) return 'searching';
  if (!i.fallbacks) return i.addonsPending > 0 ? 'searching' : 'empty';
  if (i.choice === 'fallback' || i.autoFallback) return 'fallback';
  const wait = i.knownNoDub ? KNOWN_NO_DUB_WAIT_MS : DUB_WAIT_MS;
  if (i.addonsPending > 0 && i.elapsedMs < wait) return 'searching';
  return 'missing';
}

/** Time until `dubPhase` may change on its own (the wait for slow addons), or 0. */
export function dubWaitLeft(i: DubPhaseInput): number {
  if (!i.dubMode || i.dubAlive > 0 || !i.fallbacks || i.addonsPending <= 0) return 0;
  const wait = i.knownNoDub ? KNOWN_NO_DUB_WAIT_MS : DUB_WAIT_MS;
  return Math.max(0, wait - i.elapsedMs);
}

/**
 * The candidates the source race and the torrent probes may spend their budget on, in their
 * order: only the dubbed ones (named or probable dubs) while the phase is `dub`, every candidate
 * otherwise (no dub left: the other versions are measured, started only once chosen).
 */
export function raceCandidates<T>(ordered: T[], phase: DubPhase, isDubbed: (c: T) => boolean): T[] {
  return phase === 'dub' ? ordered.filter(isDubbed) : ordered;
}

/** Dubbed candidates still alive, and the other versions still alive (dub mode). */
export function splitDub<T>(ordered: T[], isDubbed: (c: T) => boolean, alive: (c: T) => boolean): { dub: T[]; other: T[] } {
  const live = ordered.filter(alive);
  return { dub: live.filter(isDubbed), other: live.filter((c) => !isDubbed(c)) };
}

/** No dub (yet): nothing starts on its own (the user chooses first). */
export const holdsStart = (phase: DubPhase) => phase === 'searching' || phase === 'missing';

/** The popup is shown in `missing`, once per episode: any choice (even "Retour") ends it. */
export const showDubPrompt = (phase: DubPhase, choice?: DubChoice) => phase === 'missing' && !choice;

/** The next episode as the "À suivre" card / countdown sees it. */
export type NextDub = 'available' | 'missing' | 'unknown';
export function nextDubState(phase: DubPhase | undefined, choice?: DubChoice): NextDub {
  if (!phase || phase === 'off') return 'unknown';
  if (phase === 'dub') return 'available';
  if ((phase === 'missing' || phase === 'fallback') && choice !== 'fallback') return 'missing';
  return 'unknown';
}

// ---------- choices per episode (this session) ----------

const choices = new Map<string, DubChoice>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const ck = (seriesId: string, episode: number) => `${seriesId}:${episode}`;

export function getDubChoice(seriesId: string, episode: number): DubChoice | undefined {
  return choices.get(ck(seriesId, episode));
}

/** Remembered for the rest of the session: no second popup for this episode. */
export function setDubChoice(seriesId: string, episode: number, c: DubChoice) {
  if (choices.get(ck(seriesId, episode)) === c) return;
  choices.set(ck(seriesId, episode), c);
  emit();
}

export function useDubChoice(seriesId: string, episode: number): DubChoice | undefined {
  useSyncExternalStore(subscribe, () => version, () => version);
  return getDubChoice(seriesId, episode);
}

// ---------- what we know of a series (persisted) ----------

/** Episodes seen with / without a dub (the latest few of each). */
export type SeriesDub = { dub: number[]; noDub: number[] };

const MAX_EPS = 30;
const MAX_SERIES = 300;

/**
 * Likely without dub: a later-or-equal episode was without dub and no episode between it and this
 * one had one (dubs of partially dubbed series stop at some episode), or several episodes were
 * checked and none ever had a dub.
 */
export function knownNoDub(m: SeriesDub | undefined, episode: number): boolean {
  if (!m) return false;
  if (m.noDub.includes(episode)) return true;
  if (m.dub.includes(episode)) return false;
  if (!m.dub.length && m.noDub.length >= 2) return true;
  const before = m.noDub.filter((n) => n <= episode);
  if (!before.length) return false;
  const last = Math.max(...before);
  return !m.dub.some((n) => n > last && n <= episode);
}

export function noteDub(m: SeriesDub | undefined, episode: number, has: boolean): SeriesDub {
  const prev = m ?? { dub: [], noDub: [] };
  const add = (list: number[]) => [...list.filter((n) => n !== episode), episode].slice(-MAX_EPS);
  const drop = (list: number[]) => list.filter((n) => n !== episode);
  return has ? { dub: add(prev.dub), noDub: drop(prev.noDub) } : { dub: drop(prev.dub), noDub: add(prev.noDub) };
}

const KEY = 'huwa/dub-memory/v1';
let memory: Record<string, SeriesDub> = {};
let loaded = false;
const load = AsyncStorage.getItem(KEY)
  .then((raw) => {
    if (!raw) return;
    const saved = JSON.parse(raw) as Record<string, SeriesDub>;
    memory = { ...saved, ...memory };
  })
  .catch(() => {})
  .finally(() => {
    loaded = true;
    emit();
  });
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function seriesDub(seriesId: string): SeriesDub | undefined {
  return memory[seriesId];
}

/** Records whether `episode` of `seriesId` had a dub (checked: a dub played, or none was found). */
export function recordSeriesDub(seriesId: string, episode: number, has: boolean) {
  const prev = memory[seriesId];
  const next = noteDub(prev, episode, has);
  if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
  // Most recent last (the oldest series is dropped first).
  const rest = { ...memory };
  delete rest[seriesId];
  memory = { ...rest, [seriesId]: next };
  const ids = Object.keys(memory);
  if (ids.length > MAX_SERIES) delete memory[ids[0]];
  emit();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void load.then(() => AsyncStorage.setItem(KEY, JSON.stringify(memory)).catch(() => {}));
  }, 1000);
}

/** `knownNoDub` for this episode (re-renders once the saved memory is loaded). */
export function useKnownNoDub(seriesId: string, episode: number): boolean {
  useSyncExternalStore(subscribe, () => version, () => version);
  return loaded || Object.keys(memory).length ? knownNoDub(memory[seriesId], episode) : false;
}

/** Test helper. */
export function resetDubState() {
  choices.clear();
  memory = {};
  emit();
}
