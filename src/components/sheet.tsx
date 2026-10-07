// Bottom sheet with detents, built on Reanimated + Gesture Handler (no extra native module).
//
// · `detents="fit"`: sized to its content (up to the large height) — short pickers, options.
// · `detents={['medium', 'large']}`: opens at medium; drag up (or scroll up from the top) to
//   expand, drag down to collapse or dismiss. A flick commits (projected momentum).
// · Inner scroll hands off to the sheet: pulling down at the top of the list moves the sheet.
// · Enters with a spring from below, leaves faster with an ease-out; Reduce Motion → cross-fade.
// · Landscape: a centered card at most 560 pt wide, or a side panel (`side`) so the video stays
//   visible (subtitles sync).
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { initialWindowMetrics, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { C, DUR, EASE_OUT, R, S, SHADOW, SPRING } from '@/theme/tokens';

import { Txt } from './ui';

const ease = Easing.bezier(...EASE_OUT);

export type Detents = 'fit' | ('medium' | 'large')[];

export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  headerLeft,
  headerRight,
  detents = 'fit',
  footer,
  side,
  children,
  contentGap = S.lg,
  padded = true,
  onClosed,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  headerLeft?: ReactNode;
  headerRight?: ReactNode;
  detents?: Detents;
  /** Pinned under the content, always visible (e.g. "Voir les résultats"). */
  footer?: ReactNode;
  /** In landscape, slide in from the right edge instead of from the bottom. */
  side?: boolean;
  children: ReactNode;
  contentGap?: number;
  padded?: boolean;
  /** The sheet is gone (exit animation over, modal unmounted): another modal can be presented. */
  onClosed?: () => void;
}) {
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);
  if (!mounted) return null;
  // A fresh safe-area provider: insets from the screen underneath would include its tab bar.
  return (
    <Modal visible transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <SheetHost visible={visible} onClosed={() => {
            setMounted(false);
            onClosed?.();
          }} onClose={onClose} title={title} subtitle={subtitle}
            headerLeft={headerLeft} headerRight={headerRight} detents={detents} footer={footer} side={side} contentGap={contentGap} padded={padded}>
            {children}
          </SheetHost>
        </GestureHandlerRootView>
      </SafeAreaProvider>
    </Modal>
  );
}

function SheetHost({
  visible,
  onClosed,
  onClose,
  title,
  subtitle,
  headerLeft,
  headerRight,
  detents,
  footer,
  side,
  children,
  contentGap,
  padded,
}: {
  visible: boolean;
  onClosed: () => void;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  headerLeft?: ReactNode;
  headerRight?: ReactNode;
  detents: Detents;
  footer?: ReactNode;
  side?: boolean;
  children: ReactNode;
  contentGap: number;
  padded: boolean;
}) {
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const landscape = win.width > win.height;
  const asSide = !!side && landscape;

  // Geometry. `maxH` is the large detent; `fit` sheets shrink to their content.
  const maxH = landscape ? win.height - Math.max(insets.top, 12) : win.height - insets.top - 12;
  const [contentH, setContentH] = useState(0);
  const fit = detents === 'fit';
  const sheetH = asSide ? win.height : fit ? Math.min(maxH, contentH || maxH) : maxH;
  const medium = !fit && detents.includes('medium') ? Math.min(sheetH, Math.round(win.height * 0.56)) : sheetH;
  const startsMedium = !fit && detents[0] === 'medium';
  const sideW = Math.min(420, Math.round(win.width * 0.46));
  const cardW = landscape && !asSide ? Math.min(560, win.width - 2 * Math.max(insets.left, insets.right, S.lg)) : win.width;

  // Positions as translateY from the large detent (0 = fully open).
  const topY = 0;
  const midY = sheetH - medium;
  const hiddenY = asSide ? sideW + 40 : sheetH + 40;
  const ty = useSharedValue(hiddenY);
  const fade = useSharedValue(0);
  const scrollY = useSharedValue(0);
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const start = useSharedValue(0);
  const [measured, setMeasured] = useState(!fit || asSide);

  // Present / dismiss.
  useEffect(() => {
    if (!measured) return;
    if (visible) {
      const to = startsMedium ? midY : topY;
      if (reduce || asSide) {
        ty.set(asSide && !reduce ? withTiming(to, { duration: DUR.enter, easing: ease }) : to);
      } else {
        ty.set(withSpring(to, SPRING.sheet));
      }
      fade.set(withTiming(1, { duration: DUR.enter, easing: ease }));
    } else {
      const done = (finished?: boolean) => {
        'worklet';
        if (finished) scheduleOnRN(onClosed);
      };
      fade.set(withTiming(0, { duration: DUR.exit, easing: ease }, done));
      if (!reduce) ty.set(withTiming(hiddenY, { duration: DUR.exit + 40, easing: ease }));
    }
    // Geometry changes (rotation) re-place it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, measured]);

  // Rotation / content growth while open: snap to the matching detent.
  useEffect(() => {
    if (!visible || !measured) return;
    const cur = ty.get();
    ty.set(withSpring(cur > topY + 1 && !fit ? midY : topY, SPRING.settle));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetH, midY]);

  const snapPoints = fit || asSide ? [topY] : startsMedium || detents.includes('medium') ? [topY, midY] : [topY];

  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      scrollY.set(e.contentOffset.y);
    },
  });

  // Keeps the inner list pinned at its top while the finger drives the sheet.
  const pin = useSharedValue(0);
  useAnimatedReaction(
    () => pin.get(),
    (v, prev) => {
      if (v !== prev) scrollTo(scrollRef, 0, 0, false);
    },
  );
  const resetScroll = () => {
    'worklet';
    pin.set(pin.get() + 1);
  };
  const native = Gesture.Native();
  const pan = Gesture.Pan()
    .enabled(!asSide)
    .activeOffsetY([-8, 8])
    .failOffsetX([-24, 24])
    .simultaneousWithExternalGesture(native)
    .onStart(() => {
      start.set(ty.get());
    })
    .onChange((e) => {
      const cur = ty.get();
      const expanded = cur <= topY + 0.5;
      // Fully open: the list scrolls, unless it is at its top and the finger pulls down.
      if (expanded && (scrollY.get() > 0 || e.changeY < 0)) return;
      let next = cur + e.changeY;
      // Rubber band above the large detent.
      if (next < topY) next = topY + (next - topY) * 0.25;
      ty.set(next);
      if (scrollY.get() !== 0 || !expanded) resetScroll();
    })
    .onEnd((e) => {
      const cur = ty.get();
      if (cur <= topY + 0.5 && scrollY.get() > 0) return;
      const projected = cur + e.velocityY * 0.18;
      const lowest = snapPoints[snapPoints.length - 1];
      // Past the lowest detent by a third of the remaining height (or a flick): dismiss.
      if (projected > lowest + (sheetH - lowest) * 0.33 || (e.velocityY > 1400 && cur > lowest - 8)) {
        ty.set(withTiming(hiddenY, { duration: DUR.exit, easing: ease }));
        scheduleOnRN(onClose);
        return;
      }
      let target = snapPoints[0];
      for (const p of snapPoints) if (Math.abs(p - projected) < Math.abs(target - projected)) target = p;
      ty.set(withSpring(target, { ...SPRING.settle, velocity: e.velocityY }));
    });

  const backdrop = useAnimatedStyle(() => {
    const fromTy = asSide ? 1 : interpolate(ty.get(), [midY, sheetH], [1, 0], Extrapolation.CLAMP);
    return { opacity: Math.min(fade.get(), reduce ? 1 : fromTy) };
  });
  const sheetStyle = useAnimatedStyle(() => ({
    opacity: reduce ? fade.get() : 1,
    transform: asSide ? [{ translateX: ty.get() }] : [{ translateY: ty.get() }],
  }));
  // The footer stays on the visible edge when the sheet rests at the medium detent.
  const footerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.max(0, Math.min(ty.get(), sheetH) - topY) }],
  }));

  const onContent = (e: LayoutChangeEvent) => {
    if (!fit || asSide) return;
    const h = Math.ceil(e.nativeEvent.layout.height);
    if (Math.abs(h - contentH) > 1) setContentH(h);
    if (!measured) setMeasured(true);
  };

  const bottomPad = asSide ? insets.bottom + S.md : insets.bottom + S.lg;

  const header = (title || headerLeft || headerRight) && (
    <View style={styles.header}>
      {headerLeft}
      <View style={{ flex: 1, gap: 2 }}>
        {!!title && <Txt v="headline" numberOfLines={1} accessibilityRole="header">{title}</Txt>}
        {!!subtitle && <Txt v="footnote" numberOfLines={1}>{subtitle}</Txt>}
      </View>
      {headerRight}
      <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Fermer"
        style={({ pressed }) => [styles.close, pressed && { opacity: 0.6 }]}>
        <Ionicons name="close" size={17} color={C.text} />
      </Pressable>
    </View>
  );

  const body = (
    <>
      {!asSide && (
        <View style={styles.grabZone} accessible={false}>
          <View style={styles.grabber} />
        </View>
      )}
      {header}
      <GestureDetector gesture={native}>
        <Animated.ScrollView
          ref={scrollRef}
          onScroll={onScroll}
          scrollEventThrottle={16}
          bounces={!fit}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={fit && !asSide ? { flexGrow: 0 } : { flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: padded ? S.lg : 0,
            paddingTop: S.xs,
            paddingBottom: footer ? S.lg : bottomPad,
            gap: contentGap,
          }}>
          {children}
        </Animated.ScrollView>
      </GestureDetector>
      {footer && (
        <Animated.View style={[styles.footer, { paddingBottom: bottomPad - S.xs }, !fit && footerStyle]}>{footer}</Animated.View>
      )}
    </>
  );

  return (
    <>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: asSide ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.5)' }, backdrop]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Fermer" />
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            asSide
              ? { top: 0, bottom: 0, right: 0, width: sideW + insets.right, paddingTop: Math.max(insets.top, S.md), paddingRight: insets.right, borderTopRightRadius: 0, borderBottomLeftRadius: R.sheet }
              : { bottom: 0, height: fit ? undefined : sheetH, maxHeight: maxH, width: cardW, alignSelf: 'center', left: (win.width - cardW) / 2 },
            !measured && { opacity: 0 },
            sheetStyle,
          ]}>
          {fit && !asSide ? (
            <View onLayout={onContent} style={{ flexShrink: 1, maxHeight: maxH }}>{body}</View>
          ) : (
            body
          )}
        </Animated.View>
      </GestureDetector>
    </>
  );
}

/** A selectable row for sheets: title, optional detail, checkmark when on. */
export function SheetOption({
  title,
  detail,
  on,
  onPress,
  icon,
  right,
  disabled,
}: {
  title: string;
  detail?: string;
  on?: boolean;
  onPress: () => void;
  icon?: ReactNode;
  right?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: !!on, disabled: !!disabled }}
      style={({ pressed }) => [styles.option, on && styles.optionOn, pressed && { backgroundColor: on ? 'rgba(47,107,235,0.28)' : '#1B2335' }, disabled && { opacity: 0.45 }]}>
      {icon}
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="label" numberOfLines={1} color={on ? C.accentText : C.text}>{title}</Txt>
        {!!detail && <Txt v="footnote" numberOfLines={2}>{detail}</Txt>}
      </View>
      {right}
      {on && <Ionicons name="checkmark" size={20} color={C.accentText} />}
    </Pressable>
  );
}

/** Overline label for a group of options inside a sheet. */
export function SheetLabel({ children, right }: { children: string; right?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 2, marginBottom: -4 }}>
      <Txt v="caption">{children}</Txt>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute', backgroundColor: C.sheet, overflow: 'hidden',
    borderTopLeftRadius: R.sheet, borderTopRightRadius: R.sheet, borderCurve: 'continuous',
    borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(255,255,255,0.08)', boxShadow: SHADOW.sheet,
  },
  grabZone: { height: 22, alignItems: 'center', justifyContent: 'center' },
  grabber: { width: 36, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.24)' },
  header: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingBottom: S.md, minHeight: 44 },
  close: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.10)' },
  footer: {
    paddingHorizontal: S.lg, paddingTop: S.md, backgroundColor: C.sheet,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.hairline,
  },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 52, paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.elevated,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  optionOn: { backgroundColor: C.accentSoft, borderColor: C.accentLine },
});
