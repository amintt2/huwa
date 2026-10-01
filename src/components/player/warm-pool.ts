// Hidden, muted players opened ahead of a tap (pre-search of a detail page, next episode
// prefetch). They are created with `createVideoPlayer` (not tied to a component), so the watch
// screen can take one over: its HybridPlayer adopts the warm VideoPlayer (`adoptWarm`) and the
// buffered seconds, open connection, redirects and debrid resolution are all kept — no reload.
// A warm player nobody takes is released a little after its owner lets it go.
import { createVideoPlayer, type VideoPlayer } from 'expo-video';

export type WarmMeta = { title?: string; artist?: string; artwork?: string };

type Warm = { player: VideoPlayer; uri: string; headersKey: string; refs: number; timer?: ReturnType<typeof setTimeout>; sub?: { remove(): void } };

/** Warm players kept at once (each holds a decoder and a few MB of buffer). */
const MAX_WARM = 2;
/** How long an unowned warm player waits to be taken (screen transition, "Épisode suivant"). */
const ORPHAN_MS = 30_000;
/** Seconds buffered ahead: enough for a fast start, small enough not to waste data. */
const WARM_BUFFER_S = 20;

const pool = new Map<string, Warm>();
const hk = (h?: Record<string, string>) => JSON.stringify(h ?? {});

function dispose(w: Warm) {
  clearTimeout(w.timer);
  w.sub?.remove();
  if (pool.get(w.uri) === w) pool.delete(w.uri);
  try {
    w.player.pause();
    w.player.release();
  } catch {
    // already released
  }
}

/**
 * Opens `uri` in a hidden muted player (or reuses the one already warm) and parks it at
 * `startAt`. Returns the release function of the caller.
 */
export function warmUp(uri: string, headers: Record<string, string> | undefined, opts: { startAt?: number; meta?: WarmMeta } = {}): () => void {
  let w = pool.get(uri);
  if (w && w.headersKey !== hk(headers)) {
    dispose(w);
    w = undefined;
  }
  if (!w) {
    // Oldest unowned first, then the oldest.
    while (pool.size >= MAX_WARM) {
      const victim = [...pool.values()].find((x) => x.refs === 0) ?? pool.values().next().value!;
      dispose(victim);
    }
    const player = createVideoPlayer({ uri, headers, metadata: opts.meta });
    player.muted = true;
    player.showNowPlayingNotification = false;
    player.allowsExternalPlayback = false;
    player.bufferOptions = { preferredForwardBufferDuration: WARM_BUFFER_S };
    const created: Warm = { player, uri, headersKey: hk(headers), refs: 0 };
    const at = opts.startAt;
    if (at && at > 1) {
      // Buffer where playback will resume, not from the start.
      created.sub = player.addListener('statusChange', ({ status }) => {
        if (status !== 'readyToPlay') return;
        created.sub?.remove();
        created.sub = undefined;
        try {
          player.currentTime = at;
        } catch {
          // released
        }
      });
    }
    pool.set(uri, created);
    w = created;
  }
  const warm = w;
  warm.refs++;
  clearTimeout(warm.timer);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    warm.refs--;
    if (warm.refs > 0 || pool.get(warm.uri) !== warm) return;
    clearTimeout(warm.timer);
    warm.timer = setTimeout(() => warm.refs === 0 && dispose(warm), ORPHAN_MS);
  };
}

/** Takes the warm player of `uri` (it leaves the pool: the caller owns and releases it). */
export function takeWarm(uri: string, headers?: Record<string, string>): VideoPlayer | null {
  const w = pool.get(uri);
  if (!w || w.headersKey !== hk(headers)) return null;
  clearTimeout(w.timer);
  w.sub?.remove();
  pool.delete(uri);
  try {
    if (w.player.status === 'error') {
      w.player.release();
      return null;
    }
  } catch {
    return null;
  }
  return w.player;
}

export const hasWarm = (uri: string) => pool.has(uri);
