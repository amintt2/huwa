// Player side of the start timings (src/addons/timing.ts): engine used, fallback to mpv, first
// frame on mpv (expo-video reports it through `onFirstFrameRender`), re-buffering after the first
// frame and playback errors (as a coarse category). One hook call in components/player/Player.tsx.
import { useEventListener } from 'expo';
import { useEffect, useRef } from 'react';

import { traceFail, traceInfo, traceMark, traceStall } from '@/addons/timing';
import type { EnginePlayer } from '@/components/player/engines';

import { failReason } from './model';

const FALLBACK_REASON = 'échec du lecteur natif';

export function usePlayerTrace(player: EnginePlayer, mediaKey: string | undefined) {
  const key = useRef(mediaKey);
  const shown = useRef(false);
  useEffect(() => {
    key.current = mediaKey;
    shown.current = false;
  }, [mediaKey]);

  useEffect(
    () =>
      player.subscribeEngine(() => {
        const k = key.current;
        if (!k) return;
        traceInfo(k, { engine: player.engine, ...(player.engine === 'mpv' && player.reason === FALLBACK_REASON ? { fallbackToMpv: true } : null) });
      }),
    [player],
  );

  useEventListener(player, 'statusChange', ({ status, error }) => {
    const k = key.current;
    if (!k) return;
    if (status === 'error') traceFail(k, failReason(error?.message));
    else if (status === 'loading' && shown.current) traceStall(k, true);
    else if (status === 'readyToPlay') traceStall(k, false);
  });

  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    const k = key.current;
    if (!k || shown.current || !player.playing || currentTime <= 0) return;
    shown.current = true;
    traceInfo(k, { engine: player.engine });
    // mpv has no first-frame event: the first time update while playing is the closest.
    if (player.engine === 'mpv') traceMark(k, 'first-frame');
  });
}
