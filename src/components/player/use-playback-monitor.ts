// Feeds a PlaybackMonitor (./playback-monitor.ts) from the player's events: status (stalls),
// playing, time / buffer, duration, first frame, and for a torrent of the built-in engine its
// download rate and live peers (1 Hz status feed). One call in Player.tsx.
import { useEventListener } from 'expo';
import { useEffect } from 'react';

import { addStatusListener } from '@/torrent';
import { engineHashOf } from '@/torrent/stream-input';

import type { EnginePlayer } from './engines';
import type { PlaybackMonitor } from './playback-monitor';

export function usePlaybackMonitor(player: EnginePlayer, monitor: PlaybackMonitor | undefined, uri: string | undefined, external: boolean) {
  useEffect(() => {
    monitor?.setExternal(external);
  }, [monitor, external]);

  useEffect(
    () =>
      player.onMpvFirstFrame(() => {
        monitor?.firstFrame();
      }),
    [player, monitor],
  );

  useEventListener(player, 'statusChange', ({ status }) => {
    if (!monitor) return;
    monitor.setLoading(status === 'loading');
    if (status === 'readyToPlay') monitor.setDuration(player.duration);
  });
  useEventListener(player, 'playingChange', ({ isPlaying }) => monitor?.setPlaying(isPlaying));
  useEventListener(player, 'sourceLoad', ({ duration }) => monitor?.setDuration(duration));
  useEventListener(player, 'timeUpdate', ({ currentTime, bufferedPosition }) => {
    if (!monitor) return;
    monitor.progress(currentTime, bufferedPosition);
    // expo-video: the first time update while playing (its first frame is marked by Player.tsx too).
    if (player.playing && currentTime > 0) monitor.firstFrame();
    monitor.setPlaying(player.playing);
  });

  // Built-in torrent engine: download rate and live peers of the file playing.
  const hash = engineHashOf(uri);
  useEffect(() => {
    if (!monitor || !hash) return;
    return addStatusListener((list) => {
      const t = list.find((x) => x.infoHash === hash);
      if (t) monitor.torrent(t.downloadBps, t.peersLive);
    });
  }, [monitor, hash]);
}
