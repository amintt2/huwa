import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { FadeInDown, FadeOutDown, LinearTransition } from 'react-native-reanimated';

import { STATUS_ICON } from '@/components/lists';
import { FilterChip } from '@/components/states';
import { Chip, Cover, Press, Progress, SectionHeader, Txt } from '@/components/ui';
import { getSeries } from '@/data/catalog';
import { useT } from '@/i18n';
import { useContinueItems } from '@/store/derived';
import { useLists, WATCH_STATUSES } from '@/store/lists';
import { removeFromHistory, restoreHistory, useStore, type HistorySnapshot } from '@/store/store';
import { C, F, R, S, kindColor } from '@/theme/tokens';

export default function Library() {
  const items = useContinueItems();
  const myList = useStore((s) => s.myList);
  const lists = useLists((s) => s.lists);
  const statuses = useLists((s) => s.status);
  const t = useT();

  // Swipe left = remove from "En cours" (its progress); "Annuler" puts it back for 5 s.
  const [undo, setUndo] = useState<{ title: string; snap: HistorySnapshot } | null>(null);
  const remove = (seriesId: string, kind: 'anime' | 'manhwa', title: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setUndo({ title, snap: removeFromHistory(seriesId, kind) });
  };
  useEffect(() => {
    if (!undo) return;
    const id = setTimeout(() => setUndo(null), 5000);
    return () => clearTimeout(id);
  }, [undo]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingTop: S.sm, paddingBottom: S.xxl }}>
      <Txt v="display" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} style={{ fontSize: 28, paddingHorizontal: S.lg }}>Bibliothèque</Txt>

      <SectionHeader title="En cours" />
      <View style={{ paddingHorizontal: S.lg, gap: S.md }}>
        {items.length === 0 && <Txt v="body">Rien en cours. Lance un épisode ou un chapitre.</Txt>}
        {items.map((it) => (
          <Animated.View key={it.key} layout={LinearTransition.duration(220)}>
            <ReanimatedSwipeable
              friction={1.6}
              rightThreshold={72}
              overshootRight={false}
              renderRightActions={() => (
                <View style={styles.swipeAction}>
                  <Ionicons name="trash-outline" size={20} color={C.white} />
                  <Txt v="caption" color={C.white}>Retirer</Txt>
                </View>
              )}
              onSwipeableOpen={() => remove(it.series.id, it.kind, it.series.title)}>
              <Press onPress={() => router.push(it.href)} style={styles.row}>
                <Cover palette={it.series.palette} image={it.series.image} width={64} height={64} radius={12} />
                <View style={{ flex: 1, gap: 4 }}>
                  <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                    <Chip kind={it.bridged ? 'bridge' : it.kind} label={it.bridged ? 'SUITE DE L’ANIME' : undefined} />
                  </View>
                  <Txt v="label" numberOfLines={1}>{it.series.title}</Txt>
                  <Txt v="small">{it.label} · {it.sub}</Txt>
                  {it.progress > 0 && <Progress value={it.progress} color={kindColor(it.kind)} />}
                </View>
              </Press>
            </ReanimatedSwipeable>
          </Animated.View>
        ))}
        {items.length > 0 && <Txt v="small" style={{ textAlign: 'center' }}>Glisse vers la gauche pour retirer une série.</Txt>}
      </View>

      <SectionHeader title="Ma liste" />
      <View style={styles.grid}>
        {myList.length === 0 && <Txt v="body">Ajoute des séries avec le bouton +.</Txt>}
        {myList.map((id) => {
          const s = getSeries(id);
          if (!s) return null;
          return (
            <Press key={id} onPress={() => router.push(s.anime ? `/anime/${id}` : `/manhwa/${id}`)} style={{ width: 108, gap: 6 }}>
              <Cover palette={s.palette} image={s.image} width={108} height={152} />
              <Txt v="label" numberOfLines={1} style={{ fontSize: 13 }}>{s.title}</Txt>
              <View style={{ flexDirection: 'row', gap: 4 }}>
                {s.anime && <View style={[styles.dot, { backgroundColor: C.accentText }]} />}
                {s.manhwa && <View style={[styles.dot, { backgroundColor: C.accent }]} />}
              </View>
            </Press>
          );
        })}
      </View>

      <SectionHeader title={t('lists.title')} icon="albums-outline" action={t('lists.manage')} onAction={() => router.push('/lists')} />
      <View style={styles.wrap}>
        {WATCH_STATUSES.map((st) => {
          const n = Object.values(statuses).filter((x) => x === st).length;
          return (
            <FilterChip
              key={st}
              icon={STATUS_ICON[st]}
              label={`${t(`lists.status.${st}`)} · ${n}`}
              selected={false}
              onPress={() => router.push({ pathname: '/list/[id]', params: { id: `status-${st}` } })}
            />
          );
        })}
        {lists.map((l) => (
          <FilterChip
            key={l.id}
            icon="albums-outline"
            label={`${l.name} · ${l.seriesIds.length}`}
            selected={false}
            onPress={() => router.push({ pathname: '/list/[id]', params: { id: l.id } })}
          />
        ))}
        <FilterChip icon="add" label={t('lists.new')} selected={false} onPress={() => router.push('/lists')} />
      </View>
    </ScrollView>
    {undo && (
      <Animated.View entering={FadeInDown.duration(180)} exiting={FadeOutDown.duration(160)} style={styles.toast}>
        <Txt v="small" color={C.text} numberOfLines={1} style={{ flex: 1 }}>« {undo.title} » retiré de l’historique</Txt>
        <Press
          onPress={() => {
            restoreHistory(undo.snap);
            setUndo(null);
          }}
          hitSlop={10}
          accessibilityRole="button">
          <Txt v="label" color={C.accentText} style={{ fontSize: 14, ...F.bold }}>Annuler</Txt>
        </Press>
      </Animated.View>
    )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  swipeAction: {
    width: 96, marginLeft: S.sm, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: '#D9434F',
    alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  toast: {
    position: 'absolute', left: S.lg, right: S.lg, bottom: 104, flexDirection: 'row', alignItems: 'center', gap: S.md,
    paddingHorizontal: S.lg, paddingVertical: 14, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.borderStrong,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: 10, borderRadius: 16, backgroundColor: C.surface },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: S.md, paddingHorizontal: S.lg },
  dot: { width: 7, height: 7, borderRadius: 4 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm, paddingHorizontal: S.lg },
});
