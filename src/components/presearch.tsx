// Pre-search: the sources of the episode the user is about to play are searched (addons, race,
// debrid resolution of cached torrents) before Play is pressed, so the watch screen finds
// everything in the shared caches and starts at once. On Wi-Fi, the chosen link is also opened
// in a hidden muted player (warm pool) that the watch screen takes over.
// One target at a time for the whole app (`PresearchHost`, mounted once in the root layout):
// screens propose a target while focused (`usePresearch`), the highest priority wins
// (detail page > "Reprendre" row > home hero). Bounded:
// - nothing at all when streaming is not allowed (offline, "Wi-Fi seulement" on cellular),
// - no on-device torrent engine start, no hosted web player loaded (only its link checked),
// - the target changes or disappears: the race and the warm player stop; addon requests already
//   sent still land in the caches.
import { useIsFocused } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';

import { useSubtitles } from '@/addons/registry';
import { useSource } from '@/addons/use-source';
import { WarmPlayer } from '@/components/player/warm-player';
import { useStreamPolicy, useUnmetered } from '@/settings/network';
import { getState } from '@/store/store';

export type PresearchTarget = {
  seriesId: string;
  /** Episode id (watch route), episode number. */
  episodeId: string;
  episode: number;
  /** Shown by the system media controls once the warm player is taken over. */
  meta?: { title?: string; artist?: string; artwork?: string };
};

export const PRIORITY = { hero: 1, continue: 2, detail: 3 } as const;

type Slot = { target: PresearchTarget; priority: number; at: number };
const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();
let winner: Slot | null = null;

function pickWinner() {
  let best: Slot | null = null;
  for (const s of slots.values()) if (!best || s.priority > best.priority || (s.priority === best.priority && s.at > best.at)) best = s;
  if (best?.target.episodeId === winner?.target.episodeId && best?.priority === winner?.priority) return;
  winner = best;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getWinner = () => winner;

/**
 * Proposes `target` while the calling screen is focused and `active`, after `dwellMs` (a card
 * merely scrolled past or a slide shown for a moment does not trigger anything).
 */
export function usePresearch(owner: string, target: PresearchTarget | null | undefined, priority: number, { dwellMs = 1000, active = true } = {}) {
  const focused = useIsFocused();
  const episodeId = focused && active ? target?.episodeId : undefined;
  useEffect(() => {
    if (!episodeId || !target) return;
    const t = setTimeout(() => {
      slots.set(owner, { target, priority, at: Date.now() });
      pickWinner();
    }, dwellMs);
    return () => {
      clearTimeout(t);
      if (slots.get(owner)?.target.episodeId === episodeId) {
        slots.delete(owner);
        pickWinner();
      }
    };
    // The target object may be rebuilt on every render: the episode identifies it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, episodeId, priority, dwellMs]);
}

/** Runs the winning pre-search. Mounted once (root layout). */
export function PresearchHost() {
  const slot = useSyncExternalStore(subscribe, getWinner, getWinner);
  const policy = useStreamPolicy();
  if (!slot || !policy.allowed) return null;
  return <Presearch key={slot.target.episodeId} target={slot.target} />;
}

function Presearch({ target }: { target: PresearchTarget }) {
  const src = useSource(target.seriesId, target.episode, { preview: true });
  useSubtitles(target.seriesId, target.episode);
  const unmetered = useUnmetered();
  if (!unmetered || !src.url || src.web) return null;
  const saved = getState().episodes[target.episodeId];
  const startAt = saved && !saved.done ? saved.position : undefined;
  return <WarmPlayer key={src.url} uri={src.url} headers={src.headers} startAt={startAt} meta={target.meta} />;
}
