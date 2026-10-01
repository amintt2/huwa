// "Fake" progress shown while the sources of an episode are searched, raced and connected.
// It moves fast at first then crawls towards a ceiling it never reaches (perceived speed), jumps
// on real signals (addons answering, a source chosen, the stream connecting) and rushes to 100 %
// once the video is ready, then fades out.
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { Txt } from '@/components/ui';
import { C, S } from '@/theme/tokens';

/** search: addons answering · race: links measured / torrent resolved · connect: player loading. */
export type LoadPhase = 'search' | 'race' | 'connect' | 'ready';

const RANK: Record<LoadPhase, number> = { search: 0, race: 1, connect: 2, ready: 3 };
const LABEL: Record<LoadPhase, string> = {
  search: 'Recherche des sources…',
  race: 'Test des liens…',
  connect: 'Connexion au flux…',
  ready: 'C’est parti',
};
/** Where each phase starts (jump) and the ceiling it crawls towards. */
const FLOOR = { search: 0.06, race: 0.45, connect: 0.7 };
const CEIL = { search: 0.42, race: 0.68, connect: 0.9 };
/** No signal for this long (sources definitively failed): fade out, the empty text takes over. */
const GIVE_UP_MS = 1200;

const crawl = Easing.out(Easing.exp);

/**
 * `phase` null = nothing is loading (no source found, or an error). `answered` (0..1) is the share
 * of addons that already replied, to move the bar during the search. `onGone` fires once hidden.
 */
export function SourceLoadingBar({
  phase,
  answered = 0,
  onGone,
}: {
  phase: LoadPhase | null;
  answered?: number;
  onGone: () => void;
}) {
  const reduce = useReducedMotion();
  const p = useSharedValue(0);
  const opacity = useSharedValue(1);
  // Never goes backwards: a later phase keeps its label even if a signal flickers.
  const [top, setTop] = useState<LoadPhase>('search');
  if (phase && RANK[phase] > RANK[top]) setTop(phase);

  useEffect(() => {
    if (phase === null) {
      const t = setTimeout(() => {
        cancelAnimation(p);
        opacity.set(reduce ? 0 : withTiming(0, { duration: 200 }));
        onGone();
      }, GIVE_UP_MS);
      return () => clearTimeout(t);
    }
    const cur = RANK[phase] > RANK[top] ? phase : top;
    opacity.set(reduce ? 1 : withTiming(1, { duration: 150 }));

    if (cur === 'ready') {
      if (reduce) {
        p.set(1);
        opacity.set(0);
        onGone();
        return;
      }
      p.set(withTiming(1, { duration: 260, easing: Easing.out(Easing.quad) }));
      opacity.set(
        withDelay(260, withTiming(0, { duration: 260 }, (done) => {
          if (done) scheduleOnRN(onGone);
        })),
      );
      return;
    }

    // Search: the floor and ceiling move up as addons reply.
    const a = cur === 'search' ? Math.min(1, Math.max(0, answered)) : 0;
    const floor = cur === 'search' ? FLOOR.search + a * 0.24 : FLOOR[cur];
    const ceil = cur === 'search' ? CEIL.search + a * 0.04 : CEIL[cur];
    if (reduce) {
      p.set(Math.max(p.get(), floor));
      return;
    }
    const from = Math.max(p.get(), floor);
    p.set(
      withSequence(
        // Quick jump on a real signal…
        withTiming(from, { duration: 220, easing: Easing.out(Easing.quad) }),
        // …then a long deceleration that never quite gets there.
        withTiming(Math.max(from, ceil), { duration: cur === 'connect' ? 9000 : 7000, easing: crawl }),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, top, answered, reduce]);

  const fill = useAnimatedStyle(() => ({ width: `${p.get() * 100}%` }));
  const fade = useAnimatedStyle(() => ({ opacity: opacity.get() }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.wrap, fade]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={LABEL[top]}
      accessibilityLiveRegion="polite">
      <Txt v="small" color={C.white} numberOfLines={1} maxFontSizeMultiplier={1.4} style={styles.label}>
        {LABEL[top]}
      </Txt>
      <View style={styles.track}>
        <Animated.View style={[styles.fill, fill]} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: S.sm + 2,
    paddingHorizontal: S.xl,
  },
  label: { fontSize: 13, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 },
  track: { width: '62%', maxWidth: 320, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2, backgroundColor: C.accentText },
});
