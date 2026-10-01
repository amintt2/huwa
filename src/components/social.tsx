// Building blocks for the social screens (identity, profile, messages, settings).
// Same language as ui.tsx: dark steel surfaces, one blue accent, grouped inset lists.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, TextInput, View, type TextInputProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Badge } from '@/social/badges';
import type { RankResult } from '@/social/rank';
import { C, F, R, S } from '@/theme/tokens';

import { IconButton, Press, Progress, Txt, type IconName } from './ui';

export const DANGER = '#FF6B6B';
export const WARN = '#FFC857';

const AVATARS: [string, string][] = [
  ['#FF7A5C', '#FFC857'], ['#3DDC97', '#4DA3FF'], ['#B04FD1', '#6A58F5'], ['#4DA3FF', '#9DF0E0'], ['#E0445B', '#FFB86B'],
  ['#2F6BEB', '#7FB0FF'], ['#F5A623', '#E0445B'],
];

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic two-tone avatar from a key (or a name for legacy authors) + initial. */
export function Avatar({ seed, name, size = 34 }: { seed: string; name?: string; size?: number }) {
  const [a, b] = AVATARS[hash(seed) % AVATARS.length];
  const initial = name?.trim()[0]?.toUpperCase();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: a, borderWidth: Math.max(2, size / 14), borderColor: b, alignItems: 'center', justifyContent: 'center' }}>
      {size >= 40 && initial ? <Txt v="title" color="rgba(5,7,13,0.78)" style={{ fontSize: size * 0.42 }}>{initial}</Txt> : null}
    </View>
  );
}

/** `pseudo · k3xa·9fmo` — the fingerprint tells homonyms apart. */
export function NameLine({ name, fingerprint, size = 15 }: { name: string; fingerprint?: string; size?: number }) {
  return (
    <Txt v="label" numberOfLines={1} style={{ fontSize: size, flexShrink: 1 }}>
      {name}
      {fingerprint ? <Txt v="small" style={{ fontSize: size - 3 }}>{`  ${fingerprint}`}</Txt> : null}
    </Txt>
  );
}

/** Pushed-screen header: glass back button + title. */
export function ScreenHeader({ title, right, close }: { title: string; right?: ReactNode; close?: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: close ? S.lg : insets.top + S.sm }]}>
      <IconButton icon={close ? 'close' : 'chevron-back'} label={close ? 'Fermer' : 'Retour'} tone={close ? 'solid' : 'glass'} onPress={() => router.back()} />
      {close ? (
        <Txt v="title" numberOfLines={1} style={{ flex: 1, fontSize: 20 }}>{title}</Txt>
      ) : (
        <Txt v="display" numberOfLines={1} style={{ flex: 1, fontSize: 26 }}>{title}</Txt>
      )}
      {right}
    </View>
  );
}

/** Grouped inset list section (iOS Settings style). */
export function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ gap: S.sm }}>
      {title ? <Txt v="caption" style={{ paddingHorizontal: S.xs }}>{title}</Txt> : null}
      <View style={styles.group}>{children}</View>
      {footer ? (typeof footer === 'string' ? <Txt v="small" style={{ paddingHorizontal: S.xs, lineHeight: 18 }}>{footer}</Txt> : footer) : null}
    </View>
  );
}

export function Row({
  icon,
  iconColor = C.accentText,
  label,
  detail,
  onPress,
  right,
  destructive,
  disabled,
  chevron = !!onPress,
  last,
  accessibilityHint,
}: {
  icon?: IconName;
  iconColor?: string;
  label: string;
  detail?: string;
  onPress?: () => void;
  right?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  chevron?: boolean;
  last?: boolean;
  accessibilityHint?: string;
}) {
  const body = (
    <View style={[styles.row, !last && styles.rowLine, disabled && { opacity: 0.45 }]}>
      {icon ? (
        <View style={[styles.rowIcon, { backgroundColor: destructive ? 'rgba(255,107,107,0.14)' : C.accentSoft }]}>
          <Ionicons name={icon} size={16} color={destructive ? DANGER : iconColor} />
        </View>
      ) : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="label" color={destructive ? DANGER : C.text} numberOfLines={1}>{label}</Txt>
        {detail ? <Txt v="small" numberOfLines={2}>{detail}</Txt> : null}
      </View>
      {right}
      {chevron ? <Ionicons name="chevron-forward" size={16} color={C.text2} /> : null}
    </View>
  );
  if (!onPress || disabled) return <View accessible accessibilityState={{ disabled }}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [pressed && { backgroundColor: 'rgba(120,140,180,0.10)' }]}>
      {body}
    </Pressable>
  );
}

export function SwitchRow(props: { icon?: IconName; label: string; detail?: string; value: boolean; onChange: (v: boolean) => void; last?: boolean }) {
  return (
    <Row
      icon={props.icon}
      label={props.label}
      detail={props.detail}
      last={props.last}
      right={
        <Switch
          value={props.value}
          onValueChange={props.onChange}
          trackColor={{ true: C.accent }}
          accessibilityLabel={props.label}
        />
      }
    />
  );
}

/** Selectable option (radio) row. */
export function OptionRow({
  label,
  detail,
  selected,
  onPress,
  disabled,
  note,
  last,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  onPress?: () => void;
  disabled?: boolean;
  note?: string;
  last?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled }}
      style={({ pressed }) => [pressed && { backgroundColor: 'rgba(120,140,180,0.10)' }]}>
      <View style={[styles.row, { alignItems: 'flex-start' }, !last && styles.rowLine, disabled && { opacity: 0.5 }]}>
        <Ionicons name={selected ? 'radio-button-on' : 'radio-button-off'} size={22} color={selected ? C.accentText : C.text2} style={{ marginTop: 1 }} />
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm, flexWrap: 'wrap' }}>
            <Txt v="label">{label}</Txt>
            {note ? (
              <View style={styles.note}>
                <Txt v="caption" style={{ fontSize: 9 }}>{note}</Txt>
              </View>
            ) : null}
          </View>
          {detail ? <Txt v="small" style={{ lineHeight: 18 }}>{detail}</Txt> : null}
        </View>
      </View>
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label?: string; error?: string; counter?: number }) {
  const { label, error, counter, style, ...rest } = props;
  return (
    <View style={{ gap: S.sm }}>
      {label ? <Txt v="small">{label}</Txt> : null}
      <TextInput
        placeholderTextColor="#6F7A90"
        selectionColor={C.accentText}
        keyboardAppearance="dark"
        {...rest}
        accessibilityLabel={label ?? rest.accessibilityLabel}
        style={[styles.field, rest.multiline && { minHeight: 96, paddingTop: 14, textAlignVertical: 'top' }, !!error && { borderColor: DANGER }, style]}
      />
      {error || counter != null ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: S.sm }}>
          <Txt v="small" color={DANGER} style={{ flex: 1 }}>{error ?? ''}</Txt>
          {counter != null && props.maxLength ? <Txt v="small">{`${counter}/${props.maxLength}`}</Txt> : null}
        </View>
      ) : null}
    </View>
  );
}

export function Empty({ icon, title, text, action }: { icon: IconName; title: string; text?: string; action?: ReactNode }) {
  return (
    <View style={{ alignItems: 'center', gap: S.md, paddingVertical: S.xxl, paddingHorizontal: S.xl }}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={26} color={C.accentText} />
      </View>
      <Txt v="label" style={{ textAlign: 'center' }}>{title}</Txt>
      {text ? <Txt v="small" style={{ textAlign: 'center', lineHeight: 19 }}>{text}</Txt> : null}
      {action}
    </View>
  );
}

export function Loading() {
  return (
    <View style={{ padding: S.xxl, alignItems: 'center' }}>
      <ActivityIndicator color={C.text2} />
    </View>
  );
}

/** Count badge (unread messages). */
export function CountBadge({ n }: { n: number }) {
  if (!n) return null;
  return (
    <View style={styles.count}>
      <Txt v="caption" color={C.white} style={{ fontSize: 11, letterSpacing: 0 }}>{n > 99 ? '99+' : n}</Txt>
    </View>
  );
}

// ---------- rank ----------

export function RankCard({ rank, onPress, title = 'Rang' }: { rank: RankResult; onPress?: () => void; title?: string }) {
  const body = (
    <View style={styles.rank}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: S.md }}>
        <View style={{ gap: 4, flex: 1 }}>
          <Txt v="caption">{title}</Txt>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: S.sm }}>
            <Txt v="title">{rank.tier}</Txt>
            <Txt v="small">{`niv. ${rank.level}`}</Txt>
          </View>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 2 }}>
          <Txt v="title" color={C.accentText} style={{ fontVariant: ['tabular-nums'] }}>{rank.xp.toLocaleString('fr-FR')}</Txt>
          <Txt v="small">XP</Txt>
        </View>
        {onPress ? <Ionicons name="chevron-forward" size={16} color={C.text2} /> : null}
      </View>
      <Progress value={rank.progress} height={5} />
      <Txt v="small">
        {rank.nextTier
          ? `${(rank.nextTier.min - rank.xp).toLocaleString('fr-FR')} XP avant ${rank.nextTier.name}`
          : 'Palier maximum atteint'}
        {rank.seniorityPct ? ` · bonus d’ancienneté +${rank.seniorityPct} %` : ''}
      </Txt>
    </View>
  );
  if (!onPress) return body;
  return (
    <Press onPress={onPress} accessibilityRole="button" accessibilityLabel={`Rang ${rank.tier}, ${rank.xp} XP. Voir l’historique`}>
      {body}
    </Press>
  );
}

export function BadgeGrid({ badges, limit }: { badges: Badge[]; limit?: number }) {
  const list = limit ? [...badges].sort((a, b) => Number(b.earned) - Number(a.earned) || b.progress - a.progress).slice(0, limit) : badges;
  return (
    <View style={styles.badges}>
      {list.map((b) => (
        <View
          key={b.id}
          accessible
          accessibilityLabel={`${b.title}${b.earned ? ', obtenu' : `, ${Math.round(b.progress * 100)} %`}. ${b.description}`}
          style={[styles.badge, !b.earned && { opacity: 0.55 }]}>
          <View style={[styles.badgeIcon, b.earned && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
            <Ionicons name={(b.earned ? b.icon : 'lock-closed') as IconName} size={20} color={b.earned ? C.accentText : C.text2} />
          </View>
          <Txt v="label" numberOfLines={1} style={{ fontSize: 12, textAlign: 'center' }}>{b.title}</Txt>
          {b.earned ? (
            <Txt v="small" numberOfLines={2} style={{ fontSize: 10, textAlign: 'center' }}>{b.description}</Txt>
          ) : (
            <View style={{ width: '70%' }}>
              <Progress value={b.progress} height={3} />
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

export const shortKey = (key: string) => `${key.slice(0, 6)}…${key.slice(-4)}`;
export const profileLink = (key: string) => `huwa://u/${key}`;

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingBottom: S.md },
  group: { borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 52, paddingVertical: 10, paddingHorizontal: S.md },
  rowLine: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  rowIcon: { width: 30, height: 30, borderRadius: 8, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center' },
  note: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: R.chip, backgroundColor: C.pill, borderWidth: 1, borderColor: C.pillLine },
  field: {
    minHeight: 50, paddingHorizontal: S.lg, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface,
    borderWidth: 1, borderColor: C.border, color: C.text, ...F.medium, fontSize: 16,
  },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: C.accentSoft },
  count: { minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  rank: { gap: S.md, padding: S.lg, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm },
  badge: {
    width: '31.8%', alignItems: 'center', gap: 6, paddingVertical: S.md, paddingHorizontal: S.sm,
    borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  badgeIcon: {
    width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border,
  },
});
