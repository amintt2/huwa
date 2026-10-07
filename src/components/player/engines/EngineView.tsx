// Renders the video surface of the engine in use: expo-video's VideoView (native engine) or the
// libmpv view. Same props as VideoView; the ref reaches the VideoView (PiP) only in native mode.
import { useVideoPlayer, VideoView, type VideoPlayer, type VideoViewProps } from 'expo-video';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';

import { getMpvNativeView, type MpvViewHandle } from '../../../../modules/huwa-mpv';

import { HybridPlayer } from './hybrid-player';

/** Drop-in for `useVideoPlayer(null, setup)`: the setup runs on the native (expo-video) player. */
export function useEnginePlayer(source: null, setup?: (player: VideoPlayer) => void): HybridPlayer {
  const native = useVideoPlayer(source, setup);
  const player = useMemo(() => new HybridPlayer(native), [native]);
  useEffect(() => () => player.release(), [player]);
  return player;
}

type Props = Omit<VideoViewProps, 'player'> & { player: HybridPlayer; ref?: Ref<VideoView> };

// Stable React key per native player: on a seamless upgrade the warm view (rendered under the
// visible one) keeps its key, so it is not remounted when it becomes the visible one.
const ids = new WeakMap<VideoPlayer, number>();
let nextId = 0;
const idOf = (p: VideoPlayer) => {
  let id = ids.get(p);
  if (id == null) ids.set(p, (id = ++nextId));
  return id;
};

export function EngineView({ player, ref, style, ...rest }: Props) {
  const engine = useSyncExternalStore(player.subscribeEngine, player.getEngine, player.getEngine);
  const views = useSyncExternalStore(player.subscribeEngine, player.getViews, player.getViews);
  const slots = useSyncExternalStore(player.subscribeEngine, player.getMpvSlots, player.getMpvSlots);
  if (engine === 'mpv') {
    // One surface per libmpv instance: the visible one on top, a hidden warm one (seamless
    // source switch) under it. Keys are stable: the warm one is not remounted when it takes over.
    return (
      <View style={[style, styles.black]} pointerEvents="none">
        {slots.map((slot) => (
          <MpvSurface key={slot} player={player} slot={slot} main={player.isMainSlot(slot)} />
        ))}
      </View>
    );
  }
  const main = views[views.length - 1];
  return (
    <View style={style} pointerEvents="box-none">
      {views.map((p) =>
        p === main ? (
          // Opaque, so the warm player under it never shows through the letterbox.
          <VideoView key={idOf(p)} ref={ref} player={p} style={[StyleSheet.absoluteFill, styles.black]} {...rest} />
        ) : (
          <VideoView key={idOf(p)} player={p} style={StyleSheet.absoluteFill} nativeControls={false} contentFit={rest.contentFit} />
        ),
      )}
    </View>
  );
}

const MpvNative = getMpvNativeView();

function MpvSurface({ player, slot, main }: { player: HybridPlayer; slot: number; main: boolean }) {
  const handle = useRef<MpvViewHandle | null>(null);
  // Stop libmpv (network, decoder, GPU) as soon as the surface goes away, while the view still exists.
  useLayoutEffect(() => {
    const h = handle.current;
    return () => {
      h?.stop().catch(() => {});
    };
  }, []);
  const p = player.mpvSlot(slot);
  // Stable: a new ref function would detach and re-attach the view on every render.
  const setRef = useCallback(
    (h: MpvViewHandle | null) => {
      if (h) handle.current = h;
      p.ref(h);
    },
    [p],
  );
  const style = [StyleSheet.absoluteFill, styles.black, { zIndex: main ? 1 : 0 }];
  if (!MpvNative) return <View style={style} />;
  return (
    <MpvNative
      ref={setRef}
      style={style}
      pointerEvents="none"
      onReady={p.onReady}
      onLoaded={p.onLoaded}
      onProgress={p.onProgress}
      onStateChange={p.onStateChange}
      onTracks={p.onTracks}
      onEnd={p.onEnd}
      onMpvError={p.onMpvError}
    />
  );
}

const styles = StyleSheet.create({ black: { backgroundColor: '#000' } });
