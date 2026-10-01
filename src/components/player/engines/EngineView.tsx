// Renders the video surface of the engine in use: expo-video's VideoView (native engine) or the
// libmpv view. Same props as VideoView; the ref reaches the VideoView (PiP) only in native mode.
import { useVideoPlayer, VideoView, type VideoPlayer, type VideoViewProps } from 'expo-video';
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type Ref } from 'react';
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
  if (engine === 'mpv') return <MpvSurface player={player} style={style} />;
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

function MpvSurface({ player, style }: { player: HybridPlayer; style: VideoViewProps['style'] }) {
  const handle = useRef<MpvViewHandle | null>(null);
  // Stop libmpv (network, decoder, GPU) as soon as the surface goes away, while the view still exists.
  useLayoutEffect(() => {
    const h = handle.current;
    return () => {
      h?.stop().catch(() => {});
    };
  }, []);
  if (!MpvNative) return <View style={[style, styles.black]} />;
  const setRef = (h: MpvViewHandle | null) => {
    if (h) handle.current = h;
    player.attachView(h);
  };
  return (
    <MpvNative
      ref={setRef}
      style={[style, styles.black]}
      pointerEvents="none"
      onReady={player.viewDidMount}
      onLoaded={player.mpv.onLoaded}
      onProgress={player.mpv.onProgress}
      onStateChange={player.mpv.onStateChange}
      onTracks={player.mpv.onTracks}
      onEnd={player.mpv.onEnd}
      onMpvError={player.mpv.onMpvError}
    />
  );
}

const styles = StyleSheet.create({ black: { backgroundColor: '#000' } });
