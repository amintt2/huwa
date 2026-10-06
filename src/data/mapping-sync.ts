// Live community corrections for a series on screen: watches the manhwa's mapping room, weighs
// each author by the rank recomputed from their journal, applies my blocks and lists, and stores
// the result (data/mapping-store.ts → catalog refresh when a value becomes verified).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo, useState } from 'react';

import { getP2P } from '@/p2p';
import type { MappingProposal } from '@/p2p/contract';
import { useMe, useModeration } from '@/p2p/hooks';
import { usePrefs } from '@/p2p/prefs';
import { authorWeight } from '@/social/consensus';
import { hiddenAuthors } from '@/social/moderation';
import { replayJournal } from '@/social/rank';

import { getSeries, useCatalog, type Series } from './catalog';
import { validateProposal, type ProposalValue, type SeasonContext } from './mapping';
import { computeSeasonStates } from './mapping-consensus';
import { setSeasonStates } from './mapping-store';

/** What a correction is checked against (the season's place in its franchise). */
export function seasonContext(s: Series): SeasonContext | undefined {
  const m = s.mapping;
  if (!m || !s.anime) return undefined;
  return {
    episodes: s.anime.episodes.length,
    after: m.after,
    afterReliable: m.afterReliable,
    priorEpisodes: m.priorEpisodes,
    knownTotal: m.knownTotal,
  };
}

// ---------- author weights (rank from their journal, cached a day) ----------

const XP_KEY = 'huwa/mapping/xp/v1';
const XP_TTL = 86_400_000;
/** Journals fetched per room and session: the rest weigh as new identities. */
const MAX_LOOKUPS = 16;

let xpCache: Record<string, { xp: number; at: number }> = {};
let xpLoaded: Promise<void> | null = null;
const inflight = new Map<string, Promise<void>>();

const loadXpCache = () =>
  (xpLoaded ??= AsyncStorage.getItem(XP_KEY)
    .then((raw) => {
      if (raw) xpCache = { ...JSON.parse(raw), ...xpCache };
    })
    .catch(() => {}));

function fetchXp(key: string): Promise<void> {
  let p = inflight.get(key);
  if (!p) {
    p = getP2P()
      .journal(key)
      .then((journal) => {
        xpCache[key] = { xp: replayJournal(journal, undefined, Date.now()).xp, at: Date.now() };
        AsyncStorage.setItem(XP_KEY, JSON.stringify(xpCache)).catch(() => {});
      })
      .catch(() => {})
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** Recomputed XP of the given authors (missing until their journal is read). Also weighs comment reports. */
export function useAuthorXp(authors: string[]): Record<string, number> {
  const [tick, setTick] = useState(0);
  const list = authors.join(',');
  useEffect(() => {
    let alive = true;
    (async () => {
      await loadXpCache();
      if (alive) setTick((n) => n + 1);
      const stale = list
        .split(',')
        .filter((k) => k && !(xpCache[k] && Date.now() - xpCache[k].at < XP_TTL))
        .slice(0, MAX_LOOKUPS);
      for (const k of stale) {
        await fetchXp(k);
        if (!alive) return;
        setTick((n) => n + 1);
      }
    })();
    return () => {
      alive = false;
    };
  }, [list]);
  return useMemo(() => {
    const out: Record<string, number> = {};
    for (const k of list.split(',')) if (xpCache[k]) out[k] = xpCache[k].xp;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, tick]);
}

// ---------- hook ----------

/** Keep the community state of a series' room up to date while it is on screen. */
export function useMappingSync(series: Series | undefined) {
  const room = series?.mapping?.room;
  const [data, setData] = useState<{ room: string; list: MappingProposal[] }>();
  useEffect(() => {
    if (!room) return;
    return getP2P().watchMapping(room, (list) => setData({ room, list }));
  }, [room]);
  const proposals = useMemo(() => (data && data.room === room ? data.list : []), [data, room]);

  const moderation = useModeration();
  const me = useMe()?.key;
  const follows = usePrefs((p) => p.follows);
  const catalogVersion = useCatalog();
  const authors = useMemo(() => [...new Set(proposals.map((p) => p.author))].sort(), [proposals]);
  const xp = useAuthorXp(authors);

  useEffect(() => {
    if (!room) return;
    const contexts: Record<string, SeasonContext | undefined> = {};
    for (const id of new Set([...proposals.map((p) => p.season), series!.id])) {
      const s = getSeries(id);
      if (s?.mapping?.room === room) contexts[id] = seasonContext(s);
    }
    const followed = new Set(follows);
    setSeasonStates(
      computeSeasonStates(proposals, {
        contexts,
        weightOf: (a) => authorWeight({ xp: xp[a], followed: followed.has(a) }),
        blocked: hiddenAuthors(moderation),
        me,
      }),
    );
  }, [room, proposals, moderation, me, follows, xp, catalogVersion, series]);
}

/** Publish (or confirm) a correction for a season. Throws a French message when refused. */
export async function proposeCorrection(series: Series, value: ProposalValue) {
  const ctx = seasonContext(series);
  const room = series.mapping?.room;
  if (!ctx || !room) throw new Error('Cette série n’a pas de correspondance à corriger.');
  const error = validateProposal(value, ctx);
  if (error) throw new Error(error);
  await getP2P().proposeMapping({ room, season: series.id, ...value });
}
