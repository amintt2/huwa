// Seamless quality upgrade: a better source (found by the source race, see addons/race.ts) is
// opened in a hidden muted native player rendered under the visible one, parked a few seconds
// ahead of the current position; when it has buffered and the visible player reaches that point,
// the two are swapped (HybridPlayer.commitStage) — same position, play state, rate, volume and
// audio language, no reload.
// Never during the first seconds, while paused, buffering, in PiP / AirPlay, near the end, or
// more than once every 30 s; a warm player that stalls or errors is dropped. When the swap cannot
// be seamless (mpv on either side), nothing is interrupted: the parent keeps the better source
// for the next episode (`onDeferred`).
import { useEffect, useRef } from 'react';

import { canSwapEngines, swapBlocker, SWAP_LEAD_S, SWAP_WARM_TIMEOUT_MS, warmStep, type SwapState } from '@/addons/race';

import { decideEngine, deviceCaps, getEnginePref, type EnginePlayer } from './engines';
import { probeSource } from './engines/probe';

export type UpgradeRequest = { key: string; uri: string; headers?: Record<string, string> };

type Live = {
  external: boolean;
  /** Epoch ms when the current source started playing (null = not yet). */
  startedAt: number | null;
  onSwapped: (key: string, uri: string) => void;
  onDeferred: (key: string, reason: string) => void;
};

const TICK_MS = 250;
/** Re-parkings allowed (user seeks, main overtaking a slow warm player) before giving up. */
const MAX_RETARGETS = 4;
/** The warm player may start loading this long after the current source started. */
const WARM_FROM_MS = 4000;

/** Engine the hybrid player would pick for `uri`. */
async function engineFor(uri: string, headers?: Record<string, string>) {
  const pref = getEnginePref();
  const caps = deviceCaps();
  const probe = pref === 'auto' && caps.mpvAvailable ? await probeSource(uri, headers) : null;
  return decideEngine(pref, caps, probe).engine;
}

export function useSeamlessUpgrade(player: EnginePlayer, req: UpgradeRequest | null | undefined, live: Live) {
  const ref = useRef(live);
  const lastSwapAt = useRef<number | null>(null);
  useEffect(() => {
    ref.current = live;
  });

  const key = req?.key;
  const uri = req?.uri;
  const headersKey = JSON.stringify(req?.headers ?? {});
  useEffect(() => {
    if (!key || !uri) return;
    const headers = JSON.parse(headersKey) as Record<string, string>;
    let alive = true;
    let tick: ReturnType<typeof setInterval> | null = null;
    let armed: ReturnType<typeof setTimeout> | null = null;
    let stagedAt = 0;
    let parkedAt = 0;
    let target = 0;
    let parked = false;
    let retargets = 0;

    const stop = () => {
      alive = false;
      if (tick) clearInterval(tick);
      if (armed) clearTimeout(armed);
      tick = armed = null;
    };
    const giveUp = (reason: string) => {
      stop();
      player.abortStage();
      ref.current.onDeferred(key, reason);
    };
    const state = (): SwapState => {
      const d = player.duration;
      const { startedAt, external } = ref.current;
      return {
        playedMs: startedAt == null ? 0 : Date.now() - startedAt,
        sinceSwapMs: lastSwapAt.current == null ? null : Date.now() - lastSwapAt.current,
        playing: player.playing,
        busy: player.status !== 'readyToPlay',
        external: external || player.native.isExternalPlaybackActive,
        remainingS: isFinite(d) && d > 0 ? d - player.currentTime : Infinity,
      };
    };
    const park = (warm: NonNullable<typeof player.stagedPlayer>) => {
      target = player.currentTime + SWAP_LEAD_S * Math.max(1, player.playbackRate);
      warm.currentTime = target;
      parked = true;
      parkedAt = Date.now();
    };
    const trySwap = () => {
      if (!alive) return;
      armed = null;
      // Last check right at the swap: nothing changed under us (pause, seek, PiP…).
      if (swapBlocker(state())) return;
      if (player.commitStage()) {
        lastSwapAt.current = Date.now();
        stop();
        ref.current.onSwapped(key, uri);
      }
    };

    const step = () => {
      if (!alive) return;
      if (player.engine !== 'native') return giveUp('engine');
      const warm = player.stagedPlayer;
      if (!warm) {
        // Start warming only when a swap could happen soon (no data spent while paused, in
        // PiP, during the cooldown…); the end of the "first seconds" rule may still be pending.
        const st = state();
        const blocker = swapBlocker(st);
        if (blocker && !(blocker === 'too-early' && st.playedMs >= WARM_FROM_MS)) return;
        const p = player.stage({ uri, headers });
        if (!p) return giveUp('engine');
        stagedAt = Date.now();
        parked = false;
        return;
      }
      if (warm.status === 'error') return giveUp('error');
      if (Date.now() - stagedAt > SWAP_WARM_TIMEOUT_MS) return giveUp('stalled');
      if (!parked) {
        if (warm.status === 'readyToPlay') park(warm);
        return;
      }
      const s = warmStep({
        ready: warm.status === 'readyToPlay',
        target,
        buffered: warm.bufferedPosition,
        parkedMs: Date.now() - parkedAt,
        mainTime: player.currentTime,
      });
      if (s === 'retarget') {
        if (++retargets > MAX_RETARGETS) return giveUp('seek');
        stagedAt = Date.now();
        return park(warm);
      }
      if (s === 'swap') return trySwap();
      if (s === 'arm' && !armed && player.playing) {
        const ms = ((target - player.currentTime) / Math.max(0.25, player.playbackRate)) * 1000;
        armed = setTimeout(trySwap, Math.max(0, ms - 15));
      }
    };

    engineFor(uri, headers)
      .then((engine) => {
        if (!alive) return;
        if (!canSwapEngines(player.engine, engine)) return giveUp('engine');
        tick = setInterval(step, TICK_MS);
      })
      .catch(() => alive && giveUp('engine'));

    return () => {
      stop();
      player.abortStage();
    };
  }, [player, key, uri, headersKey]);
}
