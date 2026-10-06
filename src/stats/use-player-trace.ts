// Player side of the start timings (src/addons/timing.ts): engine used, fallback to mpv, file
// opened, first frame (expo-video: `onFirstFrameRender` in Player.tsx; mpv: its first playback
// restart after the load), re-buffering after the first frame and playback errors (as a coarse
// category). For a torrent played by the built-in engine, the engine's own start timeline
// (metadata, first peer / piece / byte served…) is attached too. One hook call in Player.tsx.
import { useEventListener } from 'expo';
import { useEffect, useRef } from 'react';

import { traceFail, traceInfo, traceMark, traceStall } from '@/addons/timing';
import type { EnginePlayer } from '@/components/player/engines';
import { addStatusListener, status as torrentStatus } from '@/torrent';
import { engineHashOf } from '@/torrent/stream-input';

import { failReason } from './model';

const FALLBACK_REASON = 'échec du lecteur natif';

export function usePlayerTrace(player: EnginePlayer, mediaKey: string | undefined, uri?: string) {
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

  // Built-in torrent engine: its start timeline follows the 1 Hz status feed until the first frame,
  // and is read once more right at the first frame (bytes served by then).
  const hash = engineHashOf(uri);
  const hashRef = useRef(hash);
  const snapshotEngine = (k: string, atFrame: boolean) => {
    const h = hashRef.current;
    if (!h) return;
    torrentStatus(h)
      .then((st) => st.start && traceInfo(k, atFrame ? { engineTimeline: st.start, engineBytesAtFrame: st.start.bytesServed } : { engineTimeline: st.start }))
      .catch(() => {});
  };
  useEffect(() => {
    hashRef.current = hash;
    const k = key.current;
    if (!k) return;
    if (!hash) {
      traceInfo(k, { engineTimeline: undefined, engineBytesAtFrame: undefined });
      return;
    }
    return addStatusListener((list) => {
      const t = list.find((x) => x.infoHash === hash)?.start;
      if (t && !shown.current && key.current === k) traceInfo(k, { engineTimeline: t });
    });
  }, [hash, mediaKey]);

  const firstFrame = (k: string) => {
    if (shown.current) return;
    shown.current = true;
    traceInfo(k, { engine: player.engine });
    traceMark(k, 'first-frame');
    snapshotEngine(k, true);
  };

  useEffect(
    () =>
      player.onMpvFirstFrame(() => {
        const k = key.current;
        if (k) firstFrame(k);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [player],
  );

  useEventListener(player, 'sourceLoad', () => {
    const k = key.current;
    if (k) traceMark(k, 'file-loaded');
  });

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
    // mpv builds without the first-frame event (Android): the first time update while playing.
    // expo-video's first frame is marked by Player.tsx (`onFirstFrameRender`): the engine snapshot
    // is taken here, at its first time update.
    if (player.engine === 'mpv') firstFrame(k);
    else {
      shown.current = true;
      traceInfo(k, { engine: player.engine });
      snapshotEngine(k, true);
    }
  });
}
