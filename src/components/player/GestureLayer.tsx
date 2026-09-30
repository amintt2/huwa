// Touch surface over the video, YouTube-style:
// - single tap: show / hide the controls
// - double tap on the left / right half: -10 s / +10 s
// - vertical drag (fullscreen only): left half = screen brightness, right half = volume
import * as Brightness from 'expo-brightness';
import { useEffect, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

export type Hud = { kind: 'volume' | 'brightness'; value: number };

// Gesture session state. Module-level (one player on screen at a time) so gesture callbacks,
// which the React Compiler treats as render-time code, don't touch refs.
const session: {
  start: { kind: Hud['kind']; value: number } | null;
  original: number | null;
  brightness: number | null;
} = { start: null, original: null, brightness: null };
const patchSession = (p: Partial<typeof session>) => Object.assign(session, p);

export function GestureLayer({
  children,
  width,
  height,
  adjust,
  seekEnabled,
  onTap,
  onDoubleTap,
  getVolume,
  setVolume,
  onHud,
}: {
  children?: ReactNode;
  width: number;
  height: number;
  /** Brightness / volume drags. */
  adjust: boolean;
  seekEnabled: boolean;
  onTap: () => void;
  onDoubleTap: (side: 'left' | 'right') => void;
  getVolume: () => number;
  setVolume: (v: number) => void;
  onHud: (hud: Hud | null) => void;
}) {
  // Put the screen brightness back when leaving the player (iOS keeps it until the device locks).
  useEffect(
    () => () => {
      const original = session.original;
      patchSession({ original: null, brightness: null });
      if (original == null) return;
      if (Platform.OS === 'android') Brightness.restoreSystemBrightnessAsync().catch(() => {});
      else Brightness.setBrightnessAsync(original).catch(() => {});
    },
    [],
  );

  const readBrightness = () => {
    if (session.brightness != null) return;
    Brightness.getBrightnessAsync()
      .then((b) => {
        patchSession({ brightness: b, original: session.original ?? b });
      })
      .catch(() => {});
  };

  const pan = Gesture.Pan()
    .runOnJS(true)
    .enabled(adjust)
    .activeOffsetY([-12, 12])
    .failOffsetX([-24, 24])
    .onBegin(() => readBrightness())
    .onStart((e) => {
      const kind = e.x < width / 2 ? 'brightness' : 'volume';
      patchSession({ start: { kind, value: kind === 'volume' ? getVolume() : (session.brightness ?? 0.5) } });
    })
    .onUpdate((e) => {
      const s = session.start;
      if (!s) return;
      const value = Math.min(1, Math.max(0, s.value - e.translationY / (height * 0.75)));
      if (s.kind === 'volume') setVolume(value);
      else {
        patchSession({ brightness: value });
        Brightness.setBrightnessAsync(value).catch(() => {});
      }
      onHud({ kind: s.kind, value });
    })
    .onFinalize(() => {
      patchSession({ start: null });
      onHud(null);
    });

  const doubleTap = Gesture.Tap()
    .runOnJS(true)
    .enabled(seekEnabled)
    .numberOfTaps(2)
    .maxDelay(260)
    .onEnd((e, ok) => {
      if (ok) onDoubleTap(e.x < width / 2 ? 'left' : 'right');
    });

  const tap = Gesture.Tap()
    .runOnJS(true)
    .maxDuration(300)
    .onEnd((_e, ok) => {
      if (ok) onTap();
    });

  const gesture = Gesture.Race(pan, Gesture.Exclusive(doubleTap, tap));

  return (
    <GestureDetector gesture={gesture}>
      <View style={StyleSheet.absoluteFill} collapsable={false}>
        {children}
      </View>
    </GestureDetector>
  );
}
