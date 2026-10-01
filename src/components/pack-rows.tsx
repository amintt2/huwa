// Shared pieces of the pack screens (install + create): checkable extension rows, notice box.
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { C, F, R, S } from '@/theme/tokens';

import { Txt } from './ui';

export const WARN = '#FFC857';
export const DANGER = '#FF6B6B';

export type RowStatus = { kind: 'busy' } | { kind: 'done' | 'already' | 'failed'; message?: string };

const STATUS = {
  done: { icon: 'checkmark-circle', color: C.success, label: 'Installé' },
  already: { icon: 'checkmark-done-circle-outline', color: C.text2, label: 'Déjà installé' },
  failed: { icon: 'alert-circle', color: DANGER, label: 'Échec' },
} as const;

export function CheckRow({
  checked,
  onToggle,
  title,
  subtitle,
  badge,
  warning,
  status,
  disabled,
  last,
}: {
  checked: boolean;
  onToggle?: () => void;
  title: string;
  subtitle?: string;
  badge?: string;
  warning?: string;
  status?: RowStatus;
  disabled?: boolean;
  last?: boolean;
}) {
  const s = status && status.kind !== 'busy' ? STATUS[status.kind] : undefined;
  return (
    <Pressable
      onPress={onToggle}
      disabled={disabled || !onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={[title, subtitle, badge, warning, s?.label].filter(Boolean).join(', ')}
      style={({ pressed }) => [pressed && { backgroundColor: 'rgba(120,140,180,0.10)' }]}>
      <View style={[styles.row, !last && styles.line]}>
        <Ionicons
          name={checked ? 'checkbox' : 'square-outline'}
          size={22}
          color={checked ? C.accentText : C.text2}
          style={[{ marginTop: 1 }, disabled && { opacity: 0.4 }]}
        />
        <View style={{ flex: 1, gap: 3 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
            <Txt v="label" numberOfLines={1} style={{ flexShrink: 1 }}>{title}</Txt>
            {badge ? (
              <View style={styles.badge}>
                <Txt v="caption" style={{ fontSize: 9 }}>{badge}</Txt>
              </View>
            ) : null}
          </View>
          {subtitle ? <Txt v="small" numberOfLines={2} style={{ fontSize: 12 }}>{subtitle}</Txt> : null}
          {warning ? (
            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-start' }}>
              <Ionicons name="warning-outline" size={14} color={WARN} style={{ marginTop: 1 }} />
              <Txt v="small" color={WARN} style={{ flex: 1, fontSize: 12, lineHeight: 16 }}>{warning}</Txt>
            </View>
          ) : null}
          {s ? (
            <Txt v="small" color={s.color} style={{ fontSize: 12, lineHeight: 16, ...F.semibold }}>
              {status && 'message' in status && status.message ? `${s.label} · ${status.message}` : s.label}
            </Txt>
          ) : null}
        </View>
        {status?.kind === 'busy' ? <ActivityIndicator color={C.text2} /> : s ? <Ionicons name={s.icon} size={20} color={s.color} /> : null}
      </View>
    </Pressable>
  );
}

export function CheckGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ gap: S.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.xs }}>
        <Txt v="caption">{title}</Txt>
        {action}
      </View>
      <View style={styles.group}>{children}</View>
    </View>
  );
}

export function Notice({ text }: { text: string }) {
  return (
    <View style={styles.notice}>
      <Ionicons name="information-circle-outline" size={18} color={WARN} />
      <Txt v="small" style={{ flex: 1, lineHeight: 18, color: C.body }}>{text}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: S.md, paddingVertical: 12, paddingHorizontal: S.md },
  line: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  group: { borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.elevated, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: R.chip, backgroundColor: C.pill, borderWidth: 1, borderColor: C.pillLine },
  notice: {
    flexDirection: 'row', gap: S.sm, alignItems: 'flex-start', padding: S.md, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: C.elevated, borderWidth: 1, borderColor: 'rgba(255,196,0,0.35)',
  },
});
