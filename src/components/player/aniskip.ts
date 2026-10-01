// Real opening / ending timestamps from AniSkip (https://api.aniskip.com, community-sourced).
//   GET /v2/skip-times/{malId}/{episode}?types[]=op&types[]=ed&types[]=mixed-op&types[]=mixed-ed
//       &types[]=recap&episodeLength={seconds}
//   → { found, results: [{ interval: { startTime, endTime }, skipType, episodeLength }] } (404 when none)
// Passing the real episode length lets the API return the submissions made on the same cut.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

export type SegmentKind = 'intro' | 'outro' | 'recap';
export type Segment = { kind: SegmentKind; start: number; end: number };

type Result = { interval: { startTime: number; endTime: number }; skipType: string; episodeLength: number };

const BASE = 'https://api.aniskip.com/v2/skip-times';
const TYPES = ['op', 'ed', 'mixed-op', 'mixed-ed', 'recap'];
const cache = new Map<string, Promise<Segment[]>>();

const kindOf = (t: string): SegmentKind | null =>
  t === 'op' || t === 'mixed-op' ? 'intro' : t === 'ed' || t === 'mixed-ed' ? 'outro' : t === 'recap' ? 'recap' : null;

async function fetchSkipTimesNet(malId: number, episode: number, duration: number): Promise<Segment[]> {
  const qs = TYPES.map((t) => `types[]=${t}`).join('&');
  const res = await fetch(`${BASE}/${malId}/${episode}?${qs}&episodeLength=${Math.round(duration)}`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { found?: boolean; results?: Result[] };
  if (!body.found || !body.results) return [];

  // One segment per kind; `op`/`ed` win over their `mixed-*` variants.
  const best = new Map<SegmentKind, { seg: Segment; exact: boolean }>();
  for (const r of body.results) {
    const kind = kindOf(r.skipType);
    if (!kind) continue;
    // Submissions made on a different cut: rescale to this file's length when it is close enough.
    const scale = r.episodeLength > 0 && duration > 0 && Math.abs(r.episodeLength - duration) > 3 ? duration / r.episodeLength : 1;
    if (scale < 0.9 || scale > 1.1) continue;
    const seg = { kind, start: r.interval.startTime * scale, end: Math.min(duration || Infinity, r.interval.endTime * scale) };
    if (seg.end - seg.start < 5) continue;
    const exact = r.skipType === 'op' || r.skipType === 'ed' || r.skipType === 'recap';
    const prev = best.get(kind);
    if (!prev || (exact && !prev.exact)) best.set(kind, { seg, exact });
  }
  return [...best.values()].map((b) => b.seg).sort((a, b) => a.start - b.start);
}

/**
 * AniSkip answer, kept on disk per episode so downloaded episodes still get their skip buttons
 * offline (the last answer is used when the network fails).
 */
export async function fetchSkipTimes(malId: number, episode: number, duration: number): Promise<Segment[]> {
  const diskKey = `huwa/aniskip/v1/${malId}:${episode}:${Math.round(duration / 5)}`;
  try {
    const segs = await fetchSkipTimesNet(malId, episode, duration);
    AsyncStorage.setItem(diskKey, JSON.stringify(segs)).catch(() => {});
    return segs;
  } catch (e) {
    const raw = await AsyncStorage.getItem(diskKey).catch(() => null);
    if (raw) return JSON.parse(raw) as Segment[];
    throw e;
  }
}

/** Segments for the episode once the duration is known; `[]` when AniSkip has nothing. */
export function useSkipTimes(malId: number | undefined | null, episode: number, duration: number) {
  const ready = !!malId && duration > 30;
  const key = ready ? `${malId}:${episode}:${Math.round(duration / 5)}` : '';
  const [state, setState] = useState<{ key: string; segments: Segment[] }>({ key: '', segments: [] });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    let p = cache.get(key);
    if (!p) {
      p = fetchSkipTimes(malId!, episode, duration);
      p.catch(() => cache.delete(key));
      cache.set(key, p);
    }
    p.then((segments) => alive && setState({ key, segments })).catch(() => alive && setState({ key, segments: [] }));
    return () => {
      alive = false;
    };
    // `duration` is folded into `key` (5 s buckets).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { segments: state.key === key ? state.segments : [], loaded: !key || state.key === key };
}

/**
 * Opening of the neighbouring episodes (same season, same cut), for episodes AniSkip has no data
 * for yet (often right after airing). `length` is reliable within a season (same song);
 * `start` only when the neighbours agree (no cold open shifting it), otherwise null.
 */
export type IntroGuess = { length: number; start: number | null };

export function guessIntro(neighbours: Segment[][]): IntroGuess | null {
  const intros = neighbours.map((segs) => segs.find((s) => s.kind === 'intro')).filter((s): s is Segment => !!s);
  if (!intros.length) return null;
  const lengths = intros.map((s) => s.end - s.start).sort((a, b) => a - b);
  const length = lengths[Math.floor(lengths.length / 2)];
  const starts = intros.map((s) => s.start);
  const agree = intros.length >= 2 && Math.max(...starts) - Math.min(...starts) <= 4;
  return { length, start: agree ? starts.reduce((a, b) => a + b, 0) / starts.length : null };
}

const NEIGHBOURS = [-1, 1, -2, 2];

/** `guessIntro` over episodes ±1, ±2 (fetched only when this episode has no intro of its own). */
export function useIntroGuess(malId: number | undefined | null, episode: number, duration: number, enabled: boolean) {
  const ready = enabled && !!malId && duration > 30;
  const key = ready ? `${malId}:${episode}:${Math.round(duration / 5)}` : '';
  const [state, setState] = useState<{ key: string; guess: IntroGuess | null }>({ key: '', guess: null });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const eps = NEIGHBOURS.map((d) => episode + d).filter((e) => e >= 1);
    Promise.all(
      eps.map((e) => {
        const k = `${malId}:${e}:${Math.round(duration / 5)}`;
        let p = cache.get(k);
        if (!p) {
          p = fetchSkipTimes(malId!, e, duration);
          p.catch(() => cache.delete(k));
          cache.set(k, p);
        }
        return p.catch(() => [] as Segment[]);
      }),
    ).then((all) => alive && setState({ key, guess: guessIntro(all) }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state.guess : null;
}
