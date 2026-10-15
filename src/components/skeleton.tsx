// Skeleton primitive (design system): a placeholder block in the shape of what is loading, with a
// soft light band sweeping across every 1.4 s. Native: Reanimated on the UI thread; the web build
// (./skeleton.web.tsx) does the same with one CSS animation. Reduce Motion: static block.
// Layout skeletons (rails, hero, detail header, lists…) are built from it in ./skeletons.tsx.
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, type ReactNode } from 'react';
import { StyleSheet, View, type DimensionValue, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming } from 'react-native-reanimated';

import { C, R } from '@/theme/tokens';

import { useReduceMotion } from './reduce-motion';

export const SWEEP_MS = 1400;
const BAND = ['rgba(255,255,255,0)', 'rgba(255,255,255,0.055)', 'rgba(255,255,255,0)'] as const;

export type SkeletonProps = {
  width?: DimensionValue;
  height?: DimensionValue;
  radius?: number;
  /** Base color: `C.surface` by default, the poster's own color for a blur-up placeholder. */
  tint?: string;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  /**
   * Plain tint first, the sweep only after this long (ms). For placeholders that usually resolve
   * at once (a cached poster): no skeleton flash, just its color for a frame.
   */
  delay?: number;
};

/** A placeholder block with a shimmer sweep. Hidden from screen readers (the container says "Chargement"). */
export function Skeleton({ width = '100%', height, radius = R.control, tint = C.surface, style, children, delay = 0 }: SkeletonProps) {
  const reduce = useReduceMotion();
  const w = useSharedValue(0);
  const t = useSharedValue(0);
  useEffect(() => {
    if (reduce) return;
    const sweep = withRepeat(withTiming(1, { duration: SWEEP_MS, easing: Easing.bezier(0.4, 0, 0.2, 1) }), -1, false);
    t.set(delay ? withDelay(delay, sweep) : sweep);
    return () => cancelAnimation(t);
  }, [reduce, t, delay]);
  const band = useAnimatedStyle(() => ({ transform: [{ translateX: -w.get() + t.get() * w.get() * 2 }] }));
  const onLayout = (e: LayoutChangeEvent) => w.set(e.nativeEvent.layout.width);
  return (
    <View
      onLayout={onLayout}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: radius, borderCurve: 'continuous', backgroundColor: tint, overflow: 'hidden' }, style]}>
      {!reduce && (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, band]}>
          <LinearGradient colors={BAND} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
      )}
      {children}
    </View>
  );
}
