// Seamless source switch (quality upgrade or move to a smoother source, decided by the source
// controller, see addons/source-controller.ts): the new source is opened in a hidden muted player
// rendered under the visible one — an expo-video player when AVPlayer plays, a second libmpv view
// when mpv plays — parked a few seconds ahead of the current position; when it is ready and the
// visible player reaches that point, the two are swapped (HybridPlayer.commitStage): same position,
// play state, rate, volume, audio and subtitle language, no reload. External subtitles are drawn by
// the overlay (or re-added to the new mpv file) and follow the clock, so they stay in sync.
// Never while paused, buffering, in PiP / AirPlay or near the end; upgrades also wait for the first
// seconds and a cooldown (`urgent` stability switches don't). A warm player that stalls, errors or
// turns out to be another cut (other length) is dropped and the parent told (`onDeferred`).
import { useEffect, useRef } from 'react';

import { canSwapEngines, sameTimeline, swapBlocker, SWAP_LEAD_S, SWAP_WARM_TIMEOUT_MS, warmStep, type SwapState } from '@/addons/race';

import { decideEngine, deviceCaps, getEnginePref, type EnginePlayer } from './engines';
import type { StagedPlayer } from './engines/hybrid-player';
import { probeSource } from './engines/probe';

export type UpgradeRequest = {
  key: string;
  uri: string;
  headers?: Record<string, string>;
  /** Stability switch: no "first seconds" / cooldown wait (the controller already decided). */
  urgent?: boolean;
};

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
  const urgent = !!req?.urgent;
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
    const engineAtStart = player.engine;

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
        external: external || (player.engine === 'native' && player.native.isExternalPlaybackActive),
        remainingS: isFinite(d) && d > 0 ? d - player.currentTime : Infinity,
      };
    };
    /** Stability switches skip the "first seconds" and cooldown rules. */
    const blockerNow = () => {
      const b = swapBlocker(state());
      return urgent && (b === 'too-early' || b === 'cooldown') ? null : b;
    };
    const park = (warm: StagedPlayer) => {
      target = player.currentTime + SWAP_LEAD_S * Math.max(1, player.playbackRate);
      warm.currentTime = target;
      parked = true;
      parkedAt = Date.now();
    };
    const trySwap = () => {
      if (!alive) return;
      armed = null;
      // Last check right at the swap: nothing changed under us (pause, seek, PiP…).
      if (blockerNow()) return;
      if (player.commitStage()) {
        lastSwapAt.current = Date.now();
        stop();
        ref.current.onSwapped(key, uri);
      }
    };

    const step = () => {
      if (!alive) return;
      if (player.engine !== engineAtStart || !player.canStage()) return giveUp('engine');
      const warm = player.stagedPlayer;
      if (!warm) {
        // Start warming only when a swap could happen soon (no data spent while paused, in
        // PiP, during the cooldown…); the end of the "first seconds" rule may still be pending.
        const st = state();
        const blocker = blockerNow();
        if (blocker && !(blocker === 'too-early' && st.playedMs >= WARM_FROM_MS)) return;
        const p = player.stage({ uri, headers }, SWAP_LEAD_S + 2);
        if (!p) return giveUp('engine');
        stagedAt = Date.now();
        parked = false;
        return;
      }
      if (warm.status === 'error') return giveUp('error');
      if (Date.now() - stagedAt > SWAP_WARM_TIMEOUT_MS) return giveUp('stalled');
      // Another cut of the episode (intro / recap of another length): the swap would jump.
      if (!sameTimeline(player.duration, warm.duration)) return giveUp('timeline');
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

    // From mpv, any source warms in a second mpv view; from AVPlayer, only an AVPlayer source.
    (engineAtStart === 'mpv' ? Promise.resolve('mpv' as const) : engineFor(uri, headers))
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
  }, [player, key, uri, headersKey, urgent]);
}
