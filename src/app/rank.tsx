import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HistoryRow } from '@/components/history';
import { BadgeGrid, Empty, Loading, RankCard, ScreenHeader } from '@/components/social';
import { Txt } from '@/components/ui';
import type { JournalEntry } from '@/p2p/contract';
import { useMe, useProfile, useRank } from '@/p2p/hooks';
import { DEFAULT_RULES, TIERS, type RejectReason } from '@/social/rank';
import { C, F, R, S } from '@/theme/tokens';

type Line = { entry: JournalEntry; xp?: number; rejected?: RejectReason };

const dayTitle = (t: number) => {
  const d = new Date(t);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Aujourd’hui';
  if (d.toDateString() === yest.toDateString()) return 'Hier';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};

export default function Rank() {
  const { key } = useLocalSearchParams<{ key?: string }>();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const target = key && key !== me?.key ? key : undefined;
  const { profile } = useProfile(target);
  const r = useRank(target);
  const [showRejected, setShowRejected] = useState(false);

  const sections = useMemo(() => {
    if (r.loading) return [];
    const lines: Line[] = [
      ...r.rank.accepted.map((a) => ({ entry: a.entry, xp: a.xp })),
      ...(showRejected ? r.rank.rejected.map((x) => ({ entry: x.entry, rejected: x.reason })) : []),
    ].sort((a, b) => b.entry.ts - a.entry.ts);
    const byDay = new Map<string, Line[]>();
    for (const l of lines) {
      const k = new Date(l.entry.ts).toDateString();
      byDay.set(k, [...(byDay.get(k) ?? []), l]);
    }
    return [...byDay.values()].slice(0, 60).map((data) => ({
      title: dayTitle(data[0].entry.ts),
      xp: data.reduce((n, l) => n + (l.xp ?? 0), 0),
      data,
    }));
  }, [r, showRejected]);

  const title = target ? `Rang de ${profile?.name ?? '…'}` : 'Rang et historique';

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <ScreenHeader title={title} />
      {r.loading ? (
        <Loading />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(l, i) => `${l.entry.ts}-${i}`}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ paddingHorizontal: S.lg, paddingBottom: insets.bottom + S.xxl }}
          ListHeaderComponent={
            <View style={{ gap: S.xl, paddingBottom: S.lg }}>
              <RankCard rank={r.rank} title={target ? 'Son rang' : 'Ton rang'} />

              <View style={styles.tiers}>
                {TIERS.map((t, i) => {
                  const reached = i <= r.rank.tierIndex;
                  return (
                    <View key={t.name} style={styles.tier} accessible accessibilityLabel={`${t.name}, dès ${t.min} XP${reached ? ', atteint' : ''}`}>
                      <View style={[styles.dot, reached && { backgroundColor: C.accentText, borderColor: C.accentText }]} />
                      <Txt v="small" numberOfLines={1} color={i === r.rank.tierIndex ? C.text : C.text2} style={[{ fontSize: 10 }, i === r.rank.tierIndex && F.bold]}>
                        {t.name}
                      </Txt>
                    </View>
                  );
                })}
              </View>

              <View style={{ flexDirection: 'row', gap: S.md }}>
                {[
                  { label: 'Épisodes', value: r.rank.counts.ep },
                  { label: 'Chapitres', value: r.rank.counts.ch },
                  { label: 'Jours actifs', value: r.rank.activeDays },
                ].map((s) => (
                  <View key={s.label} style={styles.stat}>
                    <Txt v="title" style={{ fontVariant: ['tabular-nums'] }}>{s.value}</Txt>
                    <Txt v="small">{s.label}</Txt>
                  </View>
                ))}
              </View>

              <View style={{ gap: S.md }}>
                <Txt v="section">Succès</Txt>
                <BadgeGrid badges={r.badges} />
              </View>

              <View style={styles.rules}>
                <Txt v="label">Comment l’XP est calculée</Txt>
                <Txt v="small" style={{ lineHeight: 18 }}>
                  {`Épisode ${DEFAULT_RULES.xp.ep} XP · chapitre ${DEFAULT_RULES.xp.ch} XP · commentaire ${DEFAULT_RULES.xp.comment} XP. Pour rester crédible, un épisode ne compte que ${DEFAULT_RULES.epGapMin} min après le précédent, ${DEFAULT_RULES.epPerDay} max par jour, et l’XP quotidienne est plafonnée à ${DEFAULT_RULES.dailyXpCap}. Chaque appareil recalcule ce rang depuis le journal signé : personne ne peut s’attribuer des points.`}
                </Txt>
              </View>

              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Txt v="section">Historique</Txt>
                {r.rank.rejected.length > 0 && (
                  <Pressable onPress={() => setShowRejected((v) => !v)} accessibilityRole="switch" accessibilityState={{ checked: showRejected }} hitSlop={8}>
                    <Txt v="small" color={C.accentText} style={F.semibold}>
                      {showRejected ? 'Masquer non comptés' : `Voir non comptés (${r.rank.rejected.length})`}
                    </Txt>
                  </Pressable>
                )}
              </View>
            </View>
          }
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHead}>
              <Txt v="caption">{section.title}</Txt>
              {section.xp > 0 && <Txt v="small" color={C.accentText} style={{ fontVariant: ['tabular-nums'] }}>{`+${section.xp} XP`}</Txt>}
            </View>
          )}
          renderItem={({ item }) => <HistoryRow entry={item.entry} xp={item.xp} rejected={item.rejected} />}
          ListEmptyComponent={
            <Empty icon="time-outline" title="Pas encore d’historique" text="Termine un épisode ou un chapitre, ou publie un commentaire : ton activité apparaîtra ici." />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tiers: { flexDirection: 'row', justifyContent: 'space-between' },
  tier: { alignItems: 'center', gap: 6, flex: 1 },
  dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1, borderColor: C.borderStrong, backgroundColor: C.elevated },
  stat: { flex: 1, padding: S.md, gap: 4, borderRadius: R.card, backgroundColor: C.surface },
  rules: { gap: S.sm, padding: S.md, borderRadius: R.card, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: S.lg, paddingBottom: S.xs },
});
