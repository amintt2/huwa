// Which engine torrents the app still uses: the watch screen's source, the next-episode prefetch,
// the pre-warm of the pre-search. A torrent nobody holds any more is released in the engine
// (`release`: playback, read-ahead and open responses ended, torrent paused, no longer the focus)
// so a quick switch never leaves it downloading against the new start. Pure (timers injected),
// kept apart from the native binding for the Node tests.
//
// The release waits `delayMs` and is skipped if someone holds the torrent again by then (a pack's
// next episode, the prefetched next episode, a pre-warm taken over by the tap). It carries the
// moment it was decided: the engine ignores it when that torrent was started again after it
// (the release of the screen that was left reaching the engine after the next screen's start).

export type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type Holds = {
  hold(hash: string): void;
  drop(hash: string): void;
  holders(hash: string): number;
};

export const RELEASE_DELAY_MS = 1500;

export function createHolds(
  release: (hash: string, decidedAt: number) => void,
  { delayMs = RELEASE_DELAY_MS, now = Date.now, timers = defaultTimers }: { delayMs?: number; now?: () => number; timers?: Timers } = {},
): Holds {
  const counts = new Map<string, number>();
  const pending = new Map<string, unknown>();
  const cancel = (hash: string) => {
    const t = pending.get(hash);
    if (t !== undefined) {
      timers.clear(t);
      pending.delete(hash);
    }
  };
  return {
    hold(hash) {
      counts.set(hash, (counts.get(hash) ?? 0) + 1);
      cancel(hash);
    },
    drop(hash) {
      const n = (counts.get(hash) ?? 0) - 1;
      if (n > 0) {
        counts.set(hash, n);
        return;
      }
      counts.delete(hash);
      cancel(hash);
      const decidedAt = now();
      pending.set(
        hash,
        timers.set(() => {
          pending.delete(hash);
          if (!counts.get(hash)) release(hash, decidedAt);
        }, delayMs),
      );
    },
    holders: (hash) => counts.get(hash) ?? 0,
  };
}
