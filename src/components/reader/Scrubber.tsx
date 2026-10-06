// Vertical page scrubber on the screen edge (Paperback-style): the current page number on top, a
// thumb along the track; drag or tap anywhere on it to jump, with a haptic tick on each page.
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { haptic, Txt } from '@/components/ui';
import { C, F, R, SHADOW } from '@/theme/tokens';

const W = 38;
const LABEL_H = 34;
const THUMB_H = 26;
const PAD = 6;

export function Scrubber({ page, count, height, onPick }: { page: number; count: number; height: number; onPick: (page: number) => void }) {
  const [dragging, setDragging] = useState<number | null>(null);
  const trackH = Math.max(40, height - LABEL_H - PAD);
  const travel = trackH - THUMB_H;
  const drag = useSharedValue(-1);
  const last = useSharedValue(-1);
  const max = Math.max(0, count - 1);

  const shown = dragging ?? page;
  const frac = max ? shown / max : 0;

  const pick = (p: number) => {
    setDragging(p);
    haptic('select');
    onPick(p);
  };
  const end = () => setDragging(null);

  const at = (y: number) => {
    'worklet';
    const f = Math.min(1, Math.max(0, (y - LABEL_H - THUMB_H / 2) / Math.max(1, travel)));
    drag.set(f);
    const p = Math.round(f * max);
    if (p !== last.get()) {
      last.set(p);
      scheduleOnRN(pick, p);
    }
  };

  const pan = Gesture.Pan()
    .minDistance(0)
    .hitSlop({ left: 14, right: 6 })
    .onBegin((e) => {
      'worklet';
      last.set(-1);
      at(e.y);
    })
    .onUpdate((e) => {
      'worklet';
      at(e.y);
    })
    .onFinalize(() => {
      'worklet';
      drag.set(-1);
      scheduleOnRN(end);
    });

  const thumb = useAnimatedStyle(() => {
    const f = drag.get() >= 0 ? drag.get() : frac;
    return { transform: [{ translateY: f * travel }] };
  });

  return (
    <GestureDetector gesture={pan}>
      <View
        style={[styles.track, { height }]}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Page"
        accessibilityValue={{ text: `${shown + 1} sur ${count}` }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'increment') onPick(Math.min(max, page + 1));
          else onPick(Math.max(0, page - 1));
        }}>
        <View style={styles.label}>
          <Txt v="label" tabular color={C.text} style={{ fontSize: 13, ...F.bold }} maxFontSizeMultiplier={1.1} numberOfLines={1} adjustsFontSizeToFit>
            {shown + 1}
          </Txt>
        </View>
        <View style={{ height: trackH, alignItems: 'center' }}>
          <View style={styles.rail} />
          <Animated.View style={[styles.thumb, dragging !== null && styles.thumbOn, thumb]} />
        </View>
      </View>
    </GestureDetector>
  );
}

export const SCRUBBER_W = W;

const styles = StyleSheet.create({
  track: {
    width: W, borderRadius: R.pill, backgroundColor: C.glass, borderWidth: 1, borderColor: C.glassLine,
    boxShadow: SHADOW.float, overflow: 'hidden',
  },
  label: { height: LABEL_H, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2 },
  rail: { position: 'absolute', top: THUMB_H / 2, bottom: THUMB_H / 2, width: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.16)' },
  thumb: { position: 'absolute', top: 0, width: 24, height: THUMB_H, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.86)' },
  thumbOn: { backgroundColor: C.accentText },
});
