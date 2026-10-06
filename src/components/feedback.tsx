// Feedback states shared by every screen: empty state, skeleton placeholders, toasts.
//
// · Empty state: icon in a soft tinted circle, a title, one line, one action.
// · Skeletons match the final layout's shape (poster, row, rail) and shimmer — a soft light band
//   sweeping left to right every 1.4 s. Reduce Motion: static placeholders, no sweep.
// · Toasts: one at a time, above the tab bar, enter from below (spring), leave faster; an optional
//   action ("Annuler"). `toast()` from anywhere; `ToastHost` is mounted once in the root layout.
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { StyleSheet, View, type DimensionValue, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  SlideInDown,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { C, F, R, S, SHADOW } from '@/theme/tokens';

import { Button, Press, Txt, haptic, type IconName } from './ui';

// ---------- Empty state ----------

export function EmptyState({
  icon,
  title,
  text,
  action,
  onAction,
  actionIcon,
  children,
  compact,
  tone = 'accent',
}: {
  icon: IconName;
  title: string;
  text?: string;
  /** Label of the single action (a soft button). */
  action?: string;
  onAction?: () => void;
  actionIcon?: IconName;
  /** A custom action node instead of `action`. */
  children?: ReactNode;
  compact?: boolean;
  tone?: 'accent' | 'neutral' | 'danger';
}) {
  const tint = tone === 'danger' ? C.danger : tone === 'neutral' ? C.text2 : C.accentText;
  const soft = tone === 'danger' ? 'rgba(255,122,122,0.12)' : tone === 'neutral' ? 'rgba(255,255,255,0.06)' : 'rgba(47,107,235,0.14)';
  const line = tone === 'danger' ? 'rgba(255,122,122,0.26)' : tone === 'neutral' ? C.pillLine : C.accentLine;
  return (
    <View style={[styles.empty, compact && { paddingVertical: S.xl }]} accessible={!children && !action} accessibilityLabel={text ? `${title}. ${text}` : title}>
      <View style={[styles.halo, { backgroundColor: soft }]}>
        <View style={[styles.emptyIcon, { borderColor: line }]}>
          <Ionicons name={icon} size={26} color={tint} />
        </View>
      </View>
      <View style={{ gap: 6, alignItems: 'center' }}>
        <Txt v="headline" style={{ textAlign: 'center' }}>{title}</Txt>
        {!!text && <Txt v="body" style={{ textAlign: 'center', maxWidth: 300 }}>{text}</Txt>}
      </View>
      {action && onAction ? <Button small variant="soft" label={action} icon={actionIcon} onPress={onAction} style={{ marginTop: S.xs }} /> : null}
      {children}
    </View>
  );
}

// ---------- Skeletons ----------

const SWEEP_MS = 1400;

/** A placeholder block with a shimmer sweep. */
export function Skeleton({
  width = '100%',
  height,
  radius = R.control,
  style,
}: {
  width?: DimensionValue;
  height: DimensionValue;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduce = useReducedMotion();
  const w = useSharedValue(0);
  const t = useSharedValue(0);
  useEffect(() => {
    if (reduce) return;
    t.set(withRepeat(withTiming(1, { duration: SWEEP_MS, easing: Easing.bezier(0.4, 0, 0.2, 1) }), -1, false));
  }, [reduce, t]);
  const band = useAnimatedStyle(() => ({ transform: [{ translateX: -w.get() + t.get() * w.get() * 2 }] }));
  const onLayout = (e: LayoutChangeEvent) => w.set(e.nativeEvent.layout.width);
  return (
    <View
      onLayout={onLayout}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: radius, borderCurve: 'continuous', backgroundColor: C.surface, overflow: 'hidden' }, style]}>
      {!reduce && (
        <Animated.View style={[StyleSheet.absoluteFill, band]}>
          <LinearGradient
            colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.055)', 'rgba(255,255,255,0)']}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      )}
    </View>
  );
}

/** Rows of a list while it loads: thumbnail + two lines. */
export function SkeletonRows({ count = 5, thumb = 56, square }: { count?: number; thumb?: number; square?: boolean }) {
  return (
    <View style={{ gap: S.md }} accessibilityLabel="Chargement" accessibilityRole="progressbar">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
          <Skeleton width={square ? thumb : Math.round(thumb * 0.72)} height={thumb} radius={square ? thumb / 2 : R.poster} />
          <View style={{ flex: 1, gap: 8 }}>
            <Skeleton width={`${72 - (i % 3) * 12}%`} height={13} radius={4} />
            <Skeleton width={`${44 + (i % 2) * 14}%`} height={11} radius={4} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** A grid of posters while results load. */
export function SkeletonPosters({ count = 6, width = 108, height = 152, gap = S.md }: { count?: number; width?: number; height?: number; gap?: number }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }} accessibilityLabel="Chargement" accessibilityRole="progressbar">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={{ width, gap: 8 }}>
          <Skeleton width={width} height={height} radius={R.poster} />
          <Skeleton width={`${80 - (i % 3) * 15}%`} height={11} radius={4} />
        </View>
      ))}
    </View>
  );
}

// ---------- Toasts ----------

type ToastSpec = { id: number; text: string; icon?: IconName; tone?: 'neutral' | 'success' | 'danger'; action?: { label: string; onPress: () => void }; duration?: number };

let current: ToastSpec | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Shows a toast (replaces the visible one). Returns a function that hides it. */
export function toast(spec: Omit<ToastSpec, 'id'> | string) {
  const s = typeof spec === 'string' ? { text: spec } : spec;
  const id = ++seq;
  current = { ...s, id };
  emit();
  return () => {
    if (current?.id === id) {
      current = null;
      emit();
    }
  };
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Mounted once, above everything. `bottom` clears the tab bar on tab screens. */
export function ToastHost() {
  const t = useSyncExternalStore(subscribe, () => current);
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const [, force] = useState(0);
  useEffect(() => {
    if (!t) return;
    const timer = setTimeout(() => {
      if (current?.id === t.id) {
        current = null;
        emit();
        force((n) => n + 1);
      }
    }, t.duration ?? (t.action ? 5000 : 2600));
    return () => clearTimeout(timer);
  }, [t]);
  if (!t) return null;
  const icon = t.icon ?? (t.tone === 'success' ? 'checkmark-circle' : t.tone === 'danger' ? 'alert-circle' : undefined);
  const iconColor = t.tone === 'success' ? C.success : t.tone === 'danger' ? C.danger : C.accentText;
  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { justifyContent: 'flex-end', paddingBottom: insets.bottom + 72 }]}>
      <Animated.View
        key={t.id}
        entering={reduce ? FadeIn.duration(160) : SlideInDown.springify().damping(26).stiffness(320).mass(0.9)}
        exiting={FadeOut.duration(160)}
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        style={styles.toast}>
        {icon && <Ionicons name={icon} size={20} color={iconColor} />}
        <Txt v="small" color={C.text} numberOfLines={2} style={{ flex: 1, fontSize: 14, lineHeight: 19 }}>{t.text}</Txt>
        {t.action && (
          <Press
            onPress={() => {
              haptic('select');
              t.action?.onPress();
              current = null;
              emit();
            }}
            hitSlop={10}
            scaleTo={0.94}
            accessibilityRole="button"
            style={styles.toastAction}>
            <Txt v="label" color={C.accentText} style={{ fontSize: 14, ...F.bold }}>{t.action.label}</Txt>
          </Press>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', justifyContent: 'center', gap: S.md, paddingVertical: 48, paddingHorizontal: S.xl },
  halo: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center', marginBottom: S.xs },
  emptyIcon: {
    width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.elevated, borderWidth: 1, boxShadow: SHADOW.inset,
  },
  toast: {
    marginHorizontal: S.lg, flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 52,
    paddingLeft: S.lg, paddingRight: S.sm, paddingVertical: 10, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.borderStrong,
    boxShadow: `${SHADOW.float}, ${SHADOW.inset}`,
  },
  toastAction: { minHeight: 36, minWidth: 44, paddingHorizontal: S.md, alignItems: 'center', justifyContent: 'center', borderRadius: R.chip },
});

// ---------- Callout ----------

/** An inline note: icon + text on a soft tinted card (privacy notes, warnings, tips). */
export function Callout({
  icon = 'information-circle-outline',
  children,
  tone = 'accent',
  title,
  action,
}: {
  icon?: IconName;
  children: ReactNode;
  tone?: 'accent' | 'neutral' | 'warn' | 'danger';
  title?: string;
  action?: ReactNode;
}) {
  const tint = tone === 'warn' ? C.star : tone === 'danger' ? C.danger : tone === 'neutral' ? C.text2 : C.accentText;
  const bg = tone === 'warn' ? 'rgba(255,200,87,0.08)' : tone === 'danger' ? 'rgba(255,122,122,0.08)' : tone === 'neutral' ? C.surface : 'rgba(47,107,235,0.08)';
  const line = tone === 'warn' ? 'rgba(255,200,87,0.22)' : tone === 'danger' ? 'rgba(255,122,122,0.24)' : tone === 'neutral' ? C.border : 'rgba(127,176,255,0.20)';
  return (
    <View style={[calloutStyles.box, { backgroundColor: bg, borderColor: line }]}>
      <Ionicons name={icon} size={18} color={tint} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, gap: 4 }}>
        {!!title && <Txt v="label" color={C.text} style={{ fontSize: 14 }}>{title}</Txt>}
        {typeof children === 'string' ? <Txt v="small" color={C.body} style={{ lineHeight: 18 }}>{children}</Txt> : children}
        {action}
      </View>
    </View>
  );
}

const calloutStyles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'flex-start', gap: S.md, padding: 14, borderRadius: R.card, borderCurve: 'continuous', borderWidth: 1 },
});
