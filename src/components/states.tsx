// Shared screen chrome and states: header with back button, empty / error / offline states,
// offline banner, selectable filter chips and settings rows.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '@/i18n';
import { useOnline } from '@/settings/network';
import { C, F, R, S } from '@/theme/tokens';

import { Button, IconButton, Txt, type IconName } from './ui';

/** Title row for pushed screens (no native header in this app). */
export function ScreenHeader({ title, right }: { title: string; right?: ReactNode }) {
  const t = useT();
  return (
    <View style={styles.header}>
      <IconButton icon="chevron-back" label={t('common.back')} onPress={() => router.back()} />
      <Txt v="display" style={{ fontSize: 26, flex: 1 }} numberOfLines={1}>{title}</Txt>
      {right}
    </View>
  );
}

/** Centered empty / error state with an optional action. */
export function StateView({
  icon,
  title,
  body,
  action,
  onAction,
  compact,
}: {
  icon: IconName;
  title: string;
  body?: string;
  action?: string;
  onAction?: () => void;
  compact?: boolean;
}) {
  return (
    <View style={[styles.state, compact && { paddingVertical: S.xl }]} accessibilityRole="summary">
      <View style={styles.stateIcon}>
        <Ionicons name={icon} size={26} color={C.accentText} />
      </View>
      <Txt v="label" style={{ textAlign: 'center' }}>{title}</Txt>
      {!!body && <Txt v="small" style={{ textAlign: 'center', maxWidth: 300 }}>{body}</Txt>}
      {action && onAction && <Button small variant="soft" label={action} icon="refresh" onPress={onAction} style={{ marginTop: S.sm }} />}
    </View>
  );
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
      style={[styles.fchip, selected && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
      {icon && <Ionicons name={icon} size={13} color={selected ? C.accentText : C.text2} />}
      <Txt v="small" color={selected ? C.accentText : C.body} style={{ fontSize: 13, ...F.semibold }}>{label}</Txt>
    </Pressable>
  );
}

/** Grouped card for settings-like rows. */
export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={{ gap: S.sm }}>
      {title && <Txt v="caption" style={{ paddingHorizontal: 4 }}>{title}</Txt>}
      <View style={styles.group}>{children}</View>
    </View>
  );
}

export function Row({
  icon,
  label,
  hint,
  right,
  onPress,
  last,
  destructive,
}: {
  icon?: IconName;
  label: string;
  hint?: string;
  right?: ReactNode;
  onPress?: () => void;
  last?: boolean;
  destructive?: boolean;
}) {
  const body = (
    <View style={[styles.row, !last && styles.rowLine]}>
      {icon && <Ionicons name={icon} size={20} color={destructive ? '#FF6B6B' : C.accentText} />}
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="label" color={destructive ? '#FF6B6B' : C.text}>{label}</Txt>
        {!!hint && <Txt v="small" style={{ fontSize: 12 }}>{hint}</Txt>}
      </View>
      {right ?? (onPress ? <Ionicons name="chevron-forward" size={16} color={C.text2} /> : null)}
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => pressed && { opacity: 0.6 }}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingBottom: S.md },
  state: { alignItems: 'center', justifyContent: 'center', gap: S.sm, paddingVertical: 56, paddingHorizontal: S.xl },
  stateIcon: {
    width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentLine, marginBottom: S.xs,
  },
  banner: {
    position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 6, paddingHorizontal: 12, borderRadius: R.pill,
    backgroundColor: 'rgba(20,27,43,0.95)', borderWidth: 1, borderColor: C.borderStrong,
  },
  fchip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 34,
    paddingHorizontal: 12, borderRadius: R.pill, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  group: { borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 52, paddingVertical: 10, paddingHorizontal: S.lg },
  rowLine: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
});
