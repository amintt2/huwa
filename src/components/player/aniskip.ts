// Real opening / ending timestamps from AniSkip (https://api.aniskip.com, community-sourced).
//   GET /v2/skip-times/{malId}/{episode}?types[]=op&types[]=ed&types[]=mixed-op&types[]=mixed-ed
//       &types[]=recap&episodeLength={seconds}
//   → { found, results: [{ interval: { startTime, endTime }, skipType, episodeLength }] } (404 when none)
// Passing the real episode length lets the API return the submissions made on the same cut.
import { useEffect, useState } from 'react';

export type SegmentKind = 'intro' | 'outro' | 'recap';
export type Segment = { kind: SegmentKind; start: number; end: number };

type Result = { interval: { startTime: number; endTime: number }; skipType: string; episodeLength: number };

const BASE = 'https://api.aniskip.com/v2/skip-times';
const TYPES = ['op', 'ed', 'mixed-op', 'mixed-ed', 'recap'];
const cache = new Map<string, Promise<Segment[]>>();

const kindOf = (t: string): SegmentKind | null =>
  t === 'op' || t === 'mixed-op' ? 'intro' : t === 'ed' || t === 'mixed-ed' ? 'outro' : t === 'recap' ? 'recap' : null;

export async function fetchSkipTimes(malId: number, episode: number, duration: number): Promise<Segment[]> {
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
