// Building blocks of "Statistiques de lecture": cards, key figures, bars and the sparkline of the
// last starts. Plain Views (no chart library), same surfaces as the grouped lists of social.tsx.
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { formatMs } from '@/stats/model';
import { C, F, R, S } from '@/theme/tokens';

import { DANGER } from './social';
import { Txt } from './ui';

export function StatCard({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  return (
    <View style={{ gap: S.sm }}>
      {title ? <Txt v="caption" style={{ paddingHorizontal: S.xs }}>{title}</Txt> : null}
      <View style={styles.card}>{children}</View>
      {footer ? <Txt v="small" style={{ paddingHorizontal: S.xs, lineHeight: 18 }}>{footer}</Txt> : null}
    </View>
  );
}

/** Big figure + its label ("1,4 s" / "Démarrage médian"). */
export function Figure({ value, label, tone, small }: { value: string; label: string; tone?: string; small?: boolean }) {
  return (
    <View style={{ flex: 1, gap: 2 }} accessible accessibilityLabel={`${label} : ${value}`}>
      <Txt style={[styles.figure, small && { fontSize: 20, lineHeight: 26 }, tone ? { color: tone } : null]} numberOfLines={1}>
        {value}
      </Txt>
      <Txt v="small" numberOfLines={2}>{label}</Txt>
    </View>
  );
}

/**
 * Last starts, oldest on the left: bar height = time to first frame (capped), red stub = failed.
 */
export function Sparkline({ values, cap }: { values: (number | null)[]; cap: number }) {
  const max = Math.max(1, cap);
  const played = values.filter((v): v is number => v != null);
  const fails = values.length - played.length;
  return (
    <View
      accessible
      accessibilityLabel={`${values.length} derniers démarrages, dont ${fails} échec${fails > 1 ? 's' : ''}`}
      style={styles.spark}>
      {values.map((v, i) => (
        <View key={i} style={styles.sparkSlot}>
          {v == null ? (
            <View style={[styles.sparkBar, { height: 4, backgroundColor: DANGER }]} />
          ) : (
            <View style={[styles.sparkBar, { height: `${Math.max(6, Math.min(1, v / max) * 100)}%`, backgroundColor: v > max ? '#F5B544' : C.accentText }]} />
          )}
        </View>
      ))}
    </View>
  );
}

/** Label · figures on the right · thin bar under it (share of `max`). */
export function MetricRow({
  label,
  value,
  detail,
  fraction,
  last,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  fraction?: number;
  last?: boolean;
  tone?: string;
}) {
  return (
    <View style={[styles.metric, !last && styles.line]} accessible accessibilityLabel={`${label} : ${value}${detail ? `, ${detail}` : ''}`}>
      <View style={styles.metricHead}>
        <Txt v="label" numberOfLines={1} style={{ flex: 1, fontSize: 14 }}>{label}</Txt>
        <Txt v="label" style={[styles.num, tone ? { color: tone } : null]}>{value}</Txt>
      </View>
      {detail ? <Txt v="small" style={{ fontSize: 12 }}>{detail}</Txt> : null}
      {fraction != null ? (
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${Math.max(2, Math.min(1, fraction) * 100)}%` }, tone ? { backgroundColor: tone } : null]} />
        </View>
      ) : null}
    </View>
  );
}

/** "Toi" vs "Communauté" for one figure (two bars on a shared scale). */
export function CompareRow({ label, mine, theirs, last }: { label: string; mine?: number; theirs?: number; last?: boolean }) {
  const max = Math.max(mine ?? 0, theirs ?? 0, 1);
  const verdict =
    mine == null || theirs == null ? undefined
      : mine <= theirs * 0.9 ? 'plus rapide'
        : mine >= theirs * 1.1 ? 'plus lent'
          : 'dans la moyenne';
  return (
    <View
      style={[styles.metric, !last && styles.line]}
      accessible
      accessibilityLabel={`${label} : toi ${formatMs(mine)}, communauté ${formatMs(theirs)}${verdict ? `, ${verdict}` : ''}`}>
      <View style={styles.metricHead}>
        <Txt v="label" numberOfLines={1} style={{ flex: 1, fontSize: 14 }}>{label}</Txt>
        {verdict ? <Txt v="small" color={verdict === 'plus lent' ? '#F5B544' : verdict === 'plus rapide' ? C.success : C.text2}>{verdict}</Txt> : null}
      </View>
      <View style={styles.compareLine}>
        <Txt v="small" style={styles.who}>Toi</Txt>
        <View style={[styles.track, { flex: 1 }]}>
          {mine != null ? <View style={[styles.fill, { width: `${Math.max(2, (mine / max) * 100)}%` }]} /> : null}
        </View>
        <Txt v="small" style={styles.cmpNum}>{formatMs(mine)}</Txt>
      </View>
      <View style={styles.compareLine}>
        <Txt v="small" style={styles.who}>Réseau</Txt>
        <View style={[styles.track, { flex: 1 }]}>
          {theirs != null ? <View style={[styles.fill, { width: `${Math.max(2, (theirs / max) * 100)}%`, backgroundColor: C.text2 }]} /> : null}
        </View>
        <Txt v="small" style={styles.cmpNum}>{formatMs(theirs)}</Txt>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  figure: { ...F.heavy, fontSize: 26, lineHeight: 32, color: C.text, fontVariant: ['tabular-nums'] },
  spark: { flexDirection: 'row', alignItems: 'flex-end', height: 56, gap: 2, paddingHorizontal: S.md, paddingBottom: S.md },
  sparkSlot: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  sparkBar: { borderRadius: 2, minHeight: 3 },
  metric: { gap: 6, paddingVertical: 12, paddingHorizontal: S.md },
  metricHead: { flexDirection: 'row', alignItems: 'baseline', gap: S.sm },
  line: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  num: { fontSize: 14, fontVariant: ['tabular-nums'] },
  track: { height: 4, borderRadius: 2, backgroundColor: C.elevated, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2, backgroundColor: C.accentText },
  compareLine: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  who: { width: 52, fontSize: 12 },
  cmpNum: { width: 56, textAlign: 'right', fontSize: 12, fontVariant: ['tabular-nums'] },
});
