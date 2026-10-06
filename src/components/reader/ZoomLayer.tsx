// Pinch-to-zoom (1×–4×), double-tap to zoom, single tap passthrough, pan while zoomed.
// Every gesture callback is an explicit worklet: pinch / pan run on the UI thread, and only the
// zoomed / not-zoomed switch crosses to React (once per change, see `setZoomed`).
// Wraps the reader list: in vertical mode the list keeps its native vertical scroll and the pan
// only moves horizontally; in paged mode the list is frozen while zoomed and the pan is free.
import { useState, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

const MAX = 4;

export function ZoomLayer({
  children,
  axis,
  onTap,
  onZoomedChange,
}: {
  children: ReactNode;
  /** `x`: horizontal pan only (vertical list), `xy`: free pan (paged). */
  axis: 'x' | 'xy';
  /** Single tap, in screen points (tap zones). */
  onTap: (x: number, y: number) => void;
  onZoomedChange?: (zoomed: boolean) => void;
}) {
  const { width, height } = useWindowDimensions();
  const scale = useSharedValue(1);
  const base = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const zoomed = useSharedValue(false);

  const [isZoomed, setIsZoomed] = useState(false);
  const notify = (z: boolean) => {
    setIsZoomed(z);
    onZoomedChange?.(z);
  };

  const clampT = (s: number) => {
    'worklet';
    const mx = (width * (s - 1)) / 2;
    const my = axis === 'xy' ? (height * (s - 1)) / 2 : 0;
    tx.set(Math.min(mx, Math.max(-mx, tx.get())));
    ty.set(Math.min(my, Math.max(-my, ty.get())));
  };

  const setZoomed = (z: boolean) => {
    'worklet';
    if (zoomed.get() !== z) {
      zoomed.set(z);
      scheduleOnRN(notify, z);
    }
  };

  const reset = () => {
    'worklet';
    scale.set(withTiming(1, { duration: 220 }));
    tx.set(withTiming(0, { duration: 220 }));
    ty.set(withTiming(0, { duration: 220 }));
    base.set(1);
    setZoomed(false);
  };

  const pinch = Gesture.Pinch()
    .onStart(() => {
      'worklet';
      base.set(scale.get());
    })
    .onUpdate((e) => {
      'worklet';
      scale.set(Math.min(MAX, Math.max(0.8, base.get() * e.scale)));
      clampT(Math.max(1, scale.get()));
      setZoomed(scale.get() > 1.02);
    })
    .onEnd(() => {
      'worklet';
      if (scale.get() <= 1.02) reset();
      else base.set(scale.get());
    });

  const panBase = Gesture.Pan()
    .averageTouches(true)
    // Only while zoomed, so the list keeps its own scroll / paging otherwise.
    .enabled(isZoomed);
  const pan = (axis === 'x' ? panBase.activeOffsetX([-8, 8]).failOffsetY([-12, 12]) : panBase.minDistance(4))
    .onBegin(() => {
      'worklet';
      startX.set(tx.get());
      startY.set(ty.get());
    })
    .onUpdate((e) => {
      'worklet';
      if (!zoomed.get()) return;
      tx.set(startX.get() + e.translationX);
      if (axis === 'xy') ty.set(startY.get() + e.translationY);
      clampT(scale.get());
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDelay(250)
    .onEnd(() => {
      'worklet';
      if (scale.get() > 1.02) reset();
      else {
        scale.set(withTiming(2.2, { duration: 220 }));
        base.set(2.2);
        setZoomed(true);
      }
    });

  const tap = Gesture.Tap()
    .maxDuration(500)
    .maxDistance(12)
    .onEnd((e, ok) => {
      'worklet';
      if (ok) scheduleOnRN(onTap, e.absoluteX, e.absoluteY);
    });

  const gesture = Gesture.Simultaneous(pinch, Gesture.Exclusive(doubleTap, tap), pan);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.get() }, { translateY: ty.get() }, { scale: scale.get() }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[StyleSheet.absoluteFill, style]}>{children}</Animated.View>
    </GestureDetector>
  );
}
