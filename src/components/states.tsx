// Shared screen chrome and states: header with back button, empty / error / offline states,
// offline banner, selectable filter chips and settings rows.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, FadeIn, FadeOut, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '@/i18n';
import { useOnline } from '@/settings/network';
import { C, F, R, S, SHADOW } from '@/theme/tokens';

import { EmptyState } from './feedback';
import { Group as SocialGroup, Row as SocialRow } from './social';
import { Txt, haptic, type IconName } from './ui';

/** Title row for pushed screens (static). Prefer `Screen` from components/screen. */
export { ScreenHeader } from './social';

/** Centered empty / error state with an optional action. */
export function StateView({
  icon,
  title,
  body,
  action,
  onAction,
  compact,
  actionIcon = 'refresh',
}: {
  icon: IconName;
  title: string;
  body?: string;
  action?: string;
  onAction?: () => void;
  compact?: boolean;
  actionIcon?: IconName;
}) {
  return <EmptyState icon={icon} title={title} text={body} action={action} onAction={onAction} actionIcon={actionIcon} compact={compact} />;
}

export function LoadingView() {
  return (
    <View style={[styles.state, { paddingVertical: S.xxl }]}>
      <ActivityIndicator color={C.accentText} />
    </View>
  );
}

/** Error state that says "offline" when that's the actual cause. */
export function ErrorState({ onRetry, compact }: { onRetry: () => void; compact?: boolean }) {
  const t = useT();
  const online = useOnline();
  return online ? (
    <StateView icon="cloud-offline-outline" title={t('error.title')} body={t('error.body')} action={t('common.retry')} onAction={onRetry} compact={compact} />
  ) : (
    <StateView icon="wifi-outline" title={t('offline.title')} body={t('offline.body')} action={t('common.retry')} onAction={onRetry} compact={compact} />
  );
}

/** Thin pill shown over every screen while the device is offline. */
export function OfflineBanner() {
  const online = useOnline();
  const insets = useSafeAreaInsets();
  const t = useT();
  if (online) return null;
  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(200)}
      pointerEvents="none"
      style={[styles.banner, { top: insets.top + 6 }]}
      accessibilityLiveRegion="polite">
      <Ionicons name="cloud-offline-outline" size={14} color={C.text} />
      <Txt v="small" color={C.text} style={{ fontSize: 12, ...F.semibold }}>{t('offline.banner')}</Txt>
    </Animated.View>
  );
}

/** Selectable filter chip (search filters, segmented choices). */
export function FilterChip({ label, selected, onPress, icon }: { label: string; selected: boolean; onPress: () => void; icon?: IconName }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      hitSlop={4}
      style={({ pressed }) => [styles.fchip, selected && { backgroundColor: C.accentSoft, borderColor: C.accentLine }, pressed && { opacity: 0.7 }]}>
      {icon && <Ionicons name={icon} size={13} color={selected ? C.accentText : C.text2} />}
      <Txt v="small" color={selected ? C.accentText : C.body} numberOfLines={1} maxFontSizeMultiplier={1.6}
        style={{ fontSize: 13, flexShrink: 1, ...F.semibold }}>{label}</Txt>
    </Pressable>
  );
}

/** Grouped card for settings-like rows — the same component as the social screens'. */
export function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return <SocialGroup title={title} footer={footer}>{children}</SocialGroup>;
}

export function Row({
  hint,
  right,
  onPress,
  ...rest
}: {
  icon?: IconName;
  label: string;
  hint?: string;
  value?: string;
  right?: ReactNode;
  onPress?: () => void;
  last?: boolean;
  destructive?: boolean;
}) {
  return <SocialRow {...rest} detail={hint} right={right} onPress={onPress} chevron={!!onPress && !right} />;
}

const styles = StyleSheet.create({
  state: { alignItems: 'center', justifyContent: 'center', gap: S.sm, paddingVertical: 56, paddingHorizontal: S.xl },
  banner: {
    position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 6, paddingHorizontal: 12, borderRadius: R.pill,
    backgroundColor: 'rgba(20,27,43,0.95)', borderWidth: 1, borderColor: C.borderStrong,
  },
  fchip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36,
    paddingHorizontal: 14, borderRadius: R.pill, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
    boxShadow: SHADOW.inset,
  },
  seg: {
    flexDirection: 'row', padding: 2, minHeight: 40, borderRadius: 10, borderCurve: 'continuous',
    backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: C.pillLine,
  },
  segThumb: {
    position: 'absolute', top: 2, bottom: 2, left: 2, borderRadius: 8, borderCurve: 'continuous',
    backgroundColor: C.elevated, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
    boxShadow: `0px 1px 3px rgba(0,0,0,0.5), ${SHADOW.inset}`,
  },
  segItem: { flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', paddingHorizontal: S.sm },
});

/**
 * Segmented control (2–5 short options): a track with a thumb that slides to the selection
 * (220 ms strong ease-out; Reduce Motion: no slide). Selection haptic on change.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  style,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const reduce = useReducedMotion();
  const [w, setW] = useState(0);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const seg = w ? (w - 4) / options.length : 0;
  const x = useSharedValue(idx * seg);
  useEffect(() => {
    x.set(reduce || !seg ? idx * seg : withTiming(idx * seg, { duration: 220, easing: Easing.bezier(0.23, 1, 0.32, 1) }));
  }, [idx, seg, reduce, x]);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      style={[styles.seg, style]}>
      {seg > 0 && <Animated.View pointerEvents="none" style={[styles.segThumb, { width: seg }, thumb]} />}
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => {
              if (on) return;
              haptic('select');
              onChange(o.value);
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={o.label}
            style={styles.segItem}>
            <Txt v="small" numberOfLines={1} maxFontSizeMultiplier={1.5} color={on ? C.text : C.text2} style={{ ...F.semibold, fontSize: 13 }}>{o.label}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}
