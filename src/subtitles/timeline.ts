// Fast "what is on screen at t" over a subtitle document, and when that changes next.
// Events are sorted by start; a prefix max of end times bounds the backward walk, so long signs
// (a title shown for the whole episode) never make lookups linear.
import type { SubEvent, SubtitleDoc } from './types';

export type Timeline = {
  /** Events visible at `t`, in file order (layer, then start). */
  at: (t: number) => SubEvent[];
  /** Next time (> t) at which the visible set changes, or Infinity. */
  nextChange: (t: number) => number;
};

const cache = new WeakMap<SubtitleDoc, Timeline>();

export function timelineOf(doc: SubtitleDoc): Timeline {
  const hit = cache.get(doc);
  if (hit) return hit;
  const ev = doc.events;
  const maxEnd = new Float64Array(ev.length);
  let m = -Infinity;
  ev.forEach((e, i) => {
    m = Math.max(m, e.end);
    maxEnd[i] = m;
  });

  /** Index of the last event with start <= t (or -1). */
  const lastStarted = (t: number) => {
    let lo = 0;
    let hi = ev.length - 1;
    let last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ev[mid].start <= t) {
        last = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return last;
  };

  const at = (t: number) => {
    const out: SubEvent[] = [];
    for (let i = lastStarted(t); i >= 0 && maxEnd[i] > t; i--) {
      if (ev[i].end > t) out.push(ev[i]);
    }
    return out.sort((a, b) => a.layer - b.layer || a.start - b.start || a.id - b.id);
  };

  const nextChange = (t: number) => {
    const i = lastStarted(t);
    let next = i + 1 < ev.length ? ev[i + 1].start : Infinity;
    for (let k = i; k >= 0 && maxEnd[k] > t; k--) if (ev[k].end > t && ev[k].end < next) next = ev[k].end;
    return next;
  };

  const tl = { at, nextChange };
  cache.set(doc, tl);
  return tl;
}
