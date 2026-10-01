// Pushed-screen chrome: a large title that scrolls away and collapses into a compact bar.
//
// · The bar floats over the content (glass back button left, actions right). It is transparent at
//   rest and turns into the app's solid bar (bg 94 % + hairline) as soon as content passes under it.
// · The large title is the first row of the content. Once it has scrolled under the bar, the same
//   title fades into the bar, centered — the iOS large-title collapse, in the app's own type ramp.
// · Sheets (form sheets, modals) use `SheetTitle` instead: title left, close button right, placed
//   inside their ScrollView (a sibling above it is drawn under the content in a form sheet).
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ScrollViewProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { C, S } from '@/theme/tokens';

import { IconButton, Txt } from './ui';

/** Height of the compact bar, under the status bar. */
export const BAR_H = 52;
/** Scroll distance after which the large title has gone under the bar. */
const COLLAPSE = 40;

/** Scroll position + handler for a screen with a collapsing title. */
export function useScreenScroll() {
  const y = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      y.set(e.contentOffset.y);
    },
  });
  return { y, onScroll };
}

/** Space the content must leave above itself for the floating bar. */
export function useBarInset() {
  return useSafeAreaInsets().top + BAR_H;
}

/** The floating compact bar. `y` drives its background and the inline title. */
export function NavBar({
  title,
  y,
  right,
  onBack,
  backIcon = 'chevron-back',
  backLabel = 'Retour',
  alwaysSolid,
}: {
  title?: string;
  y?: SharedValue<number>;
  right?: ReactNode;
  onBack?: () => void;
  backIcon?: 'chevron-back' | 'close';
  backLabel?: string;
  /** Solid from the start (screens whose content is not a scroll view). */
  alwaysSolid?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const bg = useAnimatedStyle(() => ({
    opacity: alwaysSolid || !y ? 1 : interpolate(y.get(), [0, 12], [0, 1], Extrapolation.CLAMP),
  }));
  const inline = useAnimatedStyle(() => {
    const v = alwaysSolid || !y ? 1 : interpolate(y.get(), [COLLAPSE - 6, COLLAPSE + 14], [0, 1], Extrapolation.CLAMP);
    return { opacity: v, transform: [{ translateY: (1 - v) * 6 }] };
  });
  return (
    <View pointerEvents="box-none" style={[styles.bar, { paddingTop: insets.top, height: insets.top + BAR_H }]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.barBg, bg]} />
      {!!title && (
        <Animated.View pointerEvents="none" style={[styles.inline, { top: insets.top }, inline]}>
          <Txt v="headline" numberOfLines={1} maxFontSizeMultiplier={1.3} accessibilityElementsHidden importantForAccessibility="no">
            {title}
          </Txt>
        </Animated.View>
      )}
      <IconButton icon={backIcon} label={backLabel} size={40} onPress={onBack ?? (() => router.back())} />
      <View style={styles.barRight}>{right}</View>
    </View>
  );
}

/** The large title row, first in the content. */
export function LargeTitle({ title, subtitle, right, style }: { title: string; subtitle?: string; right?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.large, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        <Txt v="display" accessibilityRole="header" numberOfLines={2} style={{ flex: 1, fontSize: 30, lineHeight: 35 }}>
          {title}
        </Txt>
        {right}
      </View>
      {!!subtitle && <Txt v="body">{subtitle}</Txt>}
    </View>
  );
}

/**
 * A pushed screen: floating bar + scrolling content that starts with the large title.
 * `children` are laid out with `gap` and horizontal padding (`padded`).
 */
export function Screen({
  title,
  subtitle,
  titleRight,
  barRight,
  children,
  gap = S.xl,
  padded = true,
  contentContainerStyle,
  footer,
  ...scroll
}: {
  title: string;
  subtitle?: string;
  /** Beside the large title (e.g. a count). */
  titleRight?: ReactNode;
  /** Actions in the bar, always visible. */
  barRight?: ReactNode;
  children: ReactNode;
  gap?: number;
  padded?: boolean;
  /** Pinned under the scroll view (a composer, a bottom action). */
  footer?: ReactNode;
} & Omit<ScrollViewProps, 'children' | 'onScroll'>) {
  const insets = useSafeAreaInsets();
  const { y, onScroll } = useScreenScroll();
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
        scrollIndicatorInsets={{ top: BAR_H }}
        {...scroll}
        contentContainerStyle={[
          { paddingTop: insets.top + BAR_H, paddingBottom: footer ? S.lg : insets.bottom + S.xxl },
          contentContainerStyle,
        ]}>
        <LargeTitle title={title} subtitle={subtitle} right={titleRight} />
        <View style={{ gap, paddingHorizontal: padded ? S.lg : 0 }}>{children}</View>
      </Animated.ScrollView>
      {footer}
      <NavBar title={title} y={y} right={barRight} />
    </View>
  );
}

/** Header row of a form sheet / modal: title, optional subtitle, close button. */
export function SheetTitle({ title, subtitle, onClose, right }: { title: string; subtitle?: string; onClose?: () => void; right?: ReactNode }) {
  return (
    <View style={styles.sheetHead}>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="title" accessibilityRole="header" numberOfLines={2} style={{ fontSize: 22, lineHeight: 27 }}>{title}</Txt>
        {!!subtitle && <Txt v="small">{subtitle}</Txt>}
      </View>
      {right}
      <CloseButton onPress={onClose ?? (() => router.back())} />
    </View>
  );
}

/** The sheets' close button: 30 pt circle, 44 pt hit area (same as `Sheet`). */
export function CloseButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel="Fermer"
      style={({ pressed }) => [styles.close, pressed && { opacity: 0.6 }]}>
      <Ionicons name="close" size={17} color={C.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: S.lg, gap: S.sm,
  },
  barBg: { backgroundColor: 'rgba(5,7,13,0.97)', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.hairline },
  barRight: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  inline: { position: 'absolute', left: 72, right: 72, height: BAR_H, alignItems: 'center', justifyContent: 'center' },
  large: { paddingHorizontal: S.lg, paddingTop: S.xs, paddingBottom: S.lg, gap: 6 },
  sheetHead: { flexDirection: 'row', alignItems: 'flex-start', gap: S.md, paddingHorizontal: S.lg, paddingTop: S.xl, paddingBottom: S.sm },
  close: {
    width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.10)', marginTop: 1,
  },
});
