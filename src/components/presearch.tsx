// Pre-search: the sources of the episode the user is about to play are searched (addons, race,
// debrid resolution of cached torrents) before Play is pressed, so the watch screen finds
// everything in the shared caches and starts at once. On Wi-Fi, the chosen link is also opened
// in a hidden muted player (warm pool) that the watch screen takes over.
// One target at a time for the whole app (`PresearchHost`, mounted once in the root layout):
// screens propose a target while focused (`usePresearch`), the highest priority wins
// (detail page > "Reprendre" row > home hero). An addon added while a series page is open (even
// under the add sheet) gets its sources asked at once (see ./presearch-targets.ts). Bounded:
// - nothing at all when streaming is not allowed (offline, "Wi-Fi seulement" on cellular),
// - no on-device torrent engine start, no hosted web player loaded (only its link checked),
// - the target changes or disappears: the race and the warm player stop; addon requests already
//   sent still land in the caches.
import { useIsFocused } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';

import { useAddonSetHash, useSubtitles } from '@/addons/registry';
import { useSource } from '@/addons/use-source';
import { WarmPlayer } from '@/components/player/warm-player';
import { usePrewarm, useStreamPolicy } from '@/settings/network';
import { getState } from '@/store/store';

import { getWinner, park, propose, subscribeWinner, unpark, withdraw, type PresearchTarget } from './presearch-targets';

export { PRIORITY, type PresearchTarget } from './presearch-targets';

/**
 * Proposes `target` while the calling screen is focused and `active`, after `dwellMs` (a card
 * merely scrolled past or a slide shown for a moment does not trigger anything).
 */
export function usePresearch(owner: string, target: PresearchTarget | null | undefined, priority: number, { dwellMs = 1000, active = true } = {}) {
  const focused = useIsFocused();
  const mountedEpisodeId = active ? target?.episodeId : undefined;
  const episodeId = focused ? mountedEpisodeId : undefined;
  // Kept while mounted, focused or not: a new addon warms this target up at once (see
  // `warmUpNewAddon`), e.g. when it was added from a sheet covering the series page.
  useEffect(() => {
    if (!mountedEpisodeId || !target) return;
    park(owner, target, priority);
    return () => unpark(owner, mountedEpisodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, mountedEpisodeId, priority]);
  useEffect(() => {
    if (!episodeId || !target) return;
    const t = setTimeout(() => propose(owner, target, priority), dwellMs);
    return () => {
      clearTimeout(t);
      withdraw(owner, episodeId);
    };
    // The target object may be rebuilt on every render: the episode identifies it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, episodeId, priority, dwellMs]);
}

/** Runs the winning pre-search. Mounted once (root layout). */
export function PresearchHost() {
  const slot = useSyncExternalStore(subscribeWinner, getWinner, getWinner);
  const policy = useStreamPolicy();
  // A new installed set starts a fresh decision (never a source picked before the add); the
  // addon answers already known are reused, only the new addon is asked.
  const setHash = useAddonSetHash();
  if (!slot || !policy.allowed) return null;
  return <Presearch key={`${slot.target.episodeId}#${setHash}`} target={slot.target} />;
}

function Presearch({ target }: { target: PresearchTarget }) {
  const src = useSource(target.seriesId, target.episode, { preview: true });
  useSubtitles(target.seriesId, target.episode);
  const prewarm = usePrewarm();
  if (!prewarm || !src.url || src.web) return null;
  const saved = getState().episodes[target.episodeId];
  const startAt = saved && !saved.done ? saved.position : undefined;
  return <WarmPlayer key={src.url} uri={src.url} headers={src.headers} startAt={startAt} meta={target.meta} />;
}
