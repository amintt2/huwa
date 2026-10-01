import { LinearGradient } from 'expo-linear-gradient';
import { router, useIsFocused } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  interpolate,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type AnimatedRef,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { seriesHref } from '@/data/anilist-api';
import { continuationChapter } from '@/data/bridge';
import type { Series } from '@/data/catalog';
import { franchiseTarget, resolvePrequels, useFranchiseTarget } from '@/data/franchise';
import { C, S } from '@/theme/tokens';

import { Button, Chip, Cover, Txt } from './ui';

const HERO_H = 560;
/** Time each featured series stays on screen before the next one slides in. */
const AUTO_MS = 6000;
const SLIDE_MS = 700;
const slideEase = Easing.bezier(0.65, 0, 0.35, 1);

/** Live "Reduce Motion" setting (reanimated's hook only reads it once at startup). */
function useReduceMotion() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setOn(v));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setOn);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return on;
}

type Rotation = ReturnType<typeof createRotation>;

/**
 * Auto-rotation state machine, kept out of React (timers and gestures mutate it freely).
 * The progress timer and the slide run on the UI thread; page changes come back via `onPage`.
 */
function createRotation(o: {
  x: SharedValue<number>;
  progress: SharedValue<number>;
  autoX: SharedValue<number>;
  page: SharedValue<number>;
  onPage: (p: number) => void;
}) {
  const { x, progress, autoX } = o;
  let ref: AnimatedRef<Animated.ScrollView> | undefined;
  const st = {
    n: 0,
    width: 0,
    page: 0,
    enabled: false,
    held: false,
    dragging: false,
    sliding: false,
    /** Next run starts a fresh 6 s (a value set from JS can't be read back right away). */
    restart: true,
    dragTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  };
  const idle = () => st.enabled && !st.held && !st.dragging && !st.sliding;

  function start() {
    if (!idle()) return;
    const from = st.restart ? 0 : Math.min(progress.get(), 0.98);
    st.restart = false;
    if (from === 0) progress.set(0);
    progress.set(
      withTiming(1, { duration: (1 - from) * AUTO_MS, easing: Easing.linear }, (done) => {
        if (done) scheduleOnRN(advance);
      }),
    );
  }
  function pause() {
    cancelAnimation(progress);
  }
  function settle(p: number) {
    st.sliding = false;
    if (p !== st.page) st.restart = true;
    st.page = p;
    o.page.set(p);
    o.onPage(p);
    start();
  }
  function endSlide() {
    st.sliding = false;
  }
  function advance() {
    if (!idle()) return;
    st.sliding = true;
    const count = st.n;
    const w = st.width;
    const to = st.page + 1;
    const scroller = ref;
    autoX.set(st.page * w);
    autoX.set(
      withTiming(to * w, { duration: SLIDE_MS, easing: slideEase }, (done) => {
        autoX.set(-1);
        if (!done) {
          scheduleOnRN(endSlide);
          return;
        }
        // Landed on the clone of the first slide: jump back to the real one, invisibly.
        const wrapped = to >= count ? 0 : to;
        if (scroller) scrollTo(scroller, wrapped * w, 0, false);
        scheduleOnRN(settle, wrapped);
      }),
    );
  }

  return {
    setGeometry(n: number, width: number, scroller: AnimatedRef<Animated.ScrollView>) {
      ref = scroller;
      st.n = n;
      st.width = width;
    },
    setEnabled(on: boolean) {
      st.enabled = on;
      if (on) start();
      else pause();
    },
    /** Finger down anywhere on the hero: pause; it resumes where it was on release. */
    hold() {
      st.held = true;
      pause();
    },
    release() {
      st.held = false;
      start();
    },
    dragStart() {
      st.dragging = true;
      st.sliding = false;
      clearTimeout(st.dragTimer);
      pause();
    },
    dragSettle(p: number) {
      // Programmatic scrolls (the auto slide) also end with momentum events on iOS: not ours.
      if (!st.dragging) return;
      clearTimeout(st.dragTimer);
      st.dragging = false;
      settle(p);
    },
    /** Released exactly on a page: iOS sends no momentum events, settle from the offset. */
    dragEnd() {
      clearTimeout(st.dragTimer);
      st.dragTimer = setTimeout(() => {
        if (!st.dragging) return;
        let p = Math.round(x.get() / st.width);
        if (p >= st.n && st.n > 1) {
          p = 0;
          ref?.current?.scrollTo({ x: 0, animated: false });
        }
        this.dragSettle(Math.max(0, p));
      }, 600);
    },
    dispose() {
      clearTimeout(st.dragTimer);
      pause();
      cancelAnimation(autoX);
    },
  };
}

/**
 * Full-bleed paging hero. Art drifts at 40% of the swipe speed (parallax) — purpose: spatial depth.
 * Advances on its own every 6 s (paused while touched, off screen or with Reduce Motion) and loops
 * through a clone of the first slide so the wrap is a forward slide, not a rewind.
 * Remount it (`key`) when the list changes.
 */
export function HeroCarousel({ items }: { items: Series[] }) {
  const { width } = useWindowDimensions();
  const focused = useIsFocused();
  const reduceMotion = useReduceMotion();
  const n = items.length;
  const loop = n > 1;
  const slides = loop ? [...items, items[0]] : items;
  const auto = focused && !reduceMotion && loop;

  const ref = useAnimatedRef<Animated.ScrollView>();
  const x = useSharedValue(0);
  const progress = useSharedValue(0);
  const autoX = useSharedValue(-1);
  const pageSV = useSharedValue(0);
  const autoSV = useSharedValue(0);
  const [active, setActive] = useState(0);
  const [rot] = useState<Rotation>(() => createRotation({ x, progress, autoX, page: pageSV, onPage: setActive }));
  const { dragStart, dragEnd, dragSettle } = rot;

  // Programmatic slide on the UI thread, with our own easing (scrollTo's default is abrupt).
  useAnimatedReaction(
    () => autoX.get(),
    (v) => {
      if (v >= 0) scrollTo(ref, v, 0, false);
    },
  );

  useEffect(() => rot.setGeometry(n, width, ref), [rot, n, width, ref]);
  useEffect(() => {
    autoSV.set(auto ? 1 : 0);
    rot.setEnabled(auto);
  }, [rot, auto, autoSV]);
  useEffect(() => () => rot.dispose(), [rot]);

  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      x.set(e.contentOffset.x);
    },
    onBeginDrag: () => {
      cancelAnimation(autoX);
      autoX.set(-1);
      scheduleOnRN(dragStart);
    },
    onEndDrag: () => {
      scheduleOnRN(dragEnd);
    },
    onMomentumEnd: (e) => {
      if (autoX.get() >= 0) return;
      let p = Math.round(e.contentOffset.x / width);
      if (p >= n && n > 1) {
        scrollTo(ref, 0, 0, false);
        p = 0;
      }
      scheduleOnRN(dragSettle, Math.max(0, p));
    },
  });

  return (
    <View
      style={{ height: HERO_H }}
      onTouchStart={() => rot.hold()}
      onTouchEnd={() => rot.release()}
      onTouchCancel={() => rot.release()}>
      <Animated.ScrollView
        ref={ref}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        decelerationRate="fast"
        scrollsToTop={false}>
        {slides.map((s, i) => (
          <Slide key={i < n ? s.id : `${s.id}-loop`} series={s} index={i} x={x} width={width} active={i === active} clone={i >= n} />
        ))}
      </Animated.ScrollView>
      <View style={styles.dots} pointerEvents="none">
        {items.map((s, i) => (
          <Dot key={s.id} index={i} count={n} x={x} width={width} progress={progress} page={pageSV} auto={autoSV} />
        ))}
      </View>
    </View>
  );
}

function Slide({
  series,
  index,
  x,
  width,
  active,
  clone,
}: {
  series: Series;
  index: number;
  x: SharedValue<number>;
  width: number;
  active: boolean;
  clone: boolean;
}) {
  const eps = series.anime?.episodes ?? [];
  const { target, seasonNumber } = useFranchiseTarget(series, active);
  const nextCh = series.anime ? continuationChapter(series) : series.manhwa?.chapters[0];
  const opening = useRef(false);

  const art = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(x.get(), [(index - 1) * width, index * width, (index + 1) * width], [-width * 0.4, 0, width * 0.4], Extrapolation.CLAMP),
      },
      { scale: interpolate(x.get(), [(index - 1) * width, index * width, (index + 1) * width], [1.12, 1, 1.12], Extrapolation.CLAMP) },
    ],
  }));
  const copy = useAnimatedStyle(() => ({
    opacity: interpolate(x.get(), [(index - 0.6) * width, index * width, (index + 0.6) * width], [0, 1, 0], Extrapolation.CLAMP),
    transform: [
      { translateX: interpolate(x.get(), [(index - 1) * width, index * width, (index + 1) * width], [width * 0.15, 0, -width * 0.15], Extrapolation.CLAMP) },
    ],
  }));

  const status = series.anime
    ? series.status === 'completed'
      ? seasonNumber && seasonNumber > 1 ? `Saison ${seasonNumber} terminée` : 'Saison terminée'
      : `${seasonNumber ? `Saison ${seasonNumber} · ` : ''}${eps.length} épisodes`
    : `${series.manhwa!.chapters.length} chapitres`;

  const open = () => router.push(seriesHref(series));

  // Earlier seasons may still be resolving (first press on a fresh slide): wait a bit for them,
  // then fall back to this season.
  const play = async () => {
    if (opening.current) return;
    opening.current = true;
    try {
      let t = target;
      if (!t) {
        await Promise.race([resolvePrequels(series), new Promise((r) => setTimeout(r, 4000))]);
        t = franchiseTarget(series);
      }
      if (t) router.push(`/watch/${t.episode.id}`);
    } finally {
      opening.current = false;
    }
  };

  return (
    <Pressable
      onPress={open}
      // The title below is the accessible way in; keeping this container non-accessible lets
      // VoiceOver still reach the buttons inside.
      accessible={false}
      importantForAccessibility={clone ? 'no-hide-descendants' : 'auto'}
      accessibilityElementsHidden={clone}
      style={{ width, height: HERO_H, overflow: 'hidden' }}>
      <Animated.View style={[StyleSheet.absoluteFill, art]}>
        <Cover palette={series.palette} image={series.image} width={width} height={HERO_H} radius={0} shade="strong" />
      </Animated.View>
      {/* Top scrim so the brand and status bar stay legible on busy key art. */}
      <LinearGradient pointerEvents="none" colors={['rgba(5,7,13,0.8)', 'rgba(5,7,13,0)']} style={styles.topScrim} />
      <Animated.View style={[styles.copy, copy]}>
        <Chip kind="accent" label={status} />
        <Txt v="display" numberOfLines={2} style={{ fontSize: 34, lineHeight: 38 }} onPress={open} accessibilityRole="link"
          accessibilityHint="Ouvre la fiche de la série">
          {series.title}
        </Txt>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {series.anime && <Chip kind="anime" />}
          {series.manhwa && <Chip kind="manhwa" />}
          {series.genres.map((g) => <Chip key={g} kind="neutral" label={g} />)}
        </View>
        <Txt v="body" numberOfLines={2} color={C.body}>{series.synopsis}</Txt>
        <View style={{ flexDirection: 'row', gap: S.sm, marginTop: 4 }}>
          {eps.length > 0 && (
            <Button icon="play" label={target?.label ?? 'Regarder'} onPress={play} style={{ flex: 1 }} />
          )}
          {nextCh && (
            <Button
              variant="soft"
              icon="book"
              label={`Lire · Ch. ${nextCh.number}`}
              onPress={() => router.push(`/read/${nextCh.id}`)}
              style={{ flex: eps.length ? undefined : 1 }}
            />
          )}
        </View>
      </Animated.View>
    </Pressable>
  );
}

const DOT = 6;
const DOT_ON = 22;

/** Page dot. The current one widens and, while auto-advancing, fills up until the next slide. */
function Dot({
  index,
  count,
  x,
  width,
  progress,
  page,
  auto,
}: {
  index: number;
  count: number;
  x: SharedValue<number>;
  width: number;
  progress: SharedValue<number>;
  page: SharedValue<number>;
  auto: SharedValue<number>;
}) {
  // `x` is read in each style worklet itself: reanimated only re-runs a style for the shared
  // values its own closure captures.
  const activeness = (v: number) => {
    'worklet';
    const near = (c: number) => interpolate(v, [(c - 1) * width, c * width, (c + 1) * width], [0, 1, 0], Extrapolation.CLAMP);
    // The first dot also lights up on the trailing clone slide.
    return Math.max(near(index), index === 0 ? near(count) : 0);
  };
  const box = useAnimatedStyle(() => ({ width: DOT + activeness(x.get()) * (DOT_ON - DOT) }));
  const fill = useAnimatedStyle(() => {
    const p = activeness(x.get());
    const w = DOT + p * (DOT_ON - DOT);
    if (!auto.get()) return { width: w * p };
    return { width: page.get() === index ? Math.max(DOT, w * progress.get()) : 0 };
  });
  return (
    <Animated.View style={[styles.dot, box]}>
      <Animated.View style={[styles.dotFill, fill]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  topScrim: { position: 'absolute', left: 0, right: 0, top: 0, height: 170 },
  copy: { position: 'absolute', left: S.lg, right: S.lg, bottom: 44, gap: 10 },
  dots: { position: 'absolute', bottom: 18, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot: { height: DOT, borderRadius: DOT / 2, backgroundColor: 'rgba(127,176,255,0.35)', overflow: 'hidden' },
  dotFill: { height: DOT, borderRadius: DOT / 2, backgroundColor: C.accentText },
});
