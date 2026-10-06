import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { STATUS_ICON } from '@/components/lists';
import { FilterChip } from '@/components/states';
import { EmptyState, toast } from '@/components/feedback';
import { Chip, Cover, Press, Progress, ScreenTitle, SectionHeader, Txt } from '@/components/ui';
import { getSeries } from '@/data/catalog';
import { useT } from '@/i18n';
import { useContinueItems } from '@/store/derived';
import { useLists, WATCH_STATUSES } from '@/store/lists';
import { removeFromHistory, restoreHistory, useStore } from '@/store/store';
import { C, R, S, SHADOW, kindColor } from '@/theme/tokens';

export default function Library() {
  const items = useContinueItems();
  const myList = useStore((s) => s.myList);
  const lists = useLists((s) => s.lists);
  const statuses = useLists((s) => s.status);
  const t = useT();

  // Swipe left = remove from "En cours" (its progress); the toast's « Annuler » puts it back (5 s).
  const remove = (seriesId: string, kind: 'anime' | 'manhwa', title: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const snap = removeFromHistory(seriesId, kind);
    toast({ text: `« ${title} » retiré de « En cours »`, icon: 'trash-outline', action: { label: 'Annuler', onPress: () => restoreHistory(snap) } });
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingTop: S.sm, paddingBottom: S.xxl }}>
      <ScreenTitle title="Bibliothèque" />

      <SectionHeader title="En cours" />
      <View style={{ paddingHorizontal: S.lg, gap: S.md }}>
        {items.length === 0 && (
          <EmptyState compact icon="play-circle-outline" title="Rien en cours" text="Lance un épisode ou un chapitre : tu le retrouveras ici, là où tu t’es arrêté." />
        )}
        {items.map((it) => (
          <Animated.View key={it.key} layout={LinearTransition.duration(220)}>
            <ReanimatedSwipeable
              friction={1.6}
              rightThreshold={72}
              overshootRight={false}
              renderRightActions={() => (
                <View style={styles.swipeAction} accessibilityElementsHidden>
                  <Ionicons name="trash-outline" size={20} color={C.white} />
                  <Txt v="footnote" color={C.white} style={{ fontWeight: '600' }}>Retirer</Txt>
                </View>
              )}
              onSwipeableOpen={() => remove(it.series.id, it.kind, it.series.title)}>
              <Press onPress={() => router.push(it.href)} style={styles.row}
                accessibilityRole="button" accessibilityLabel={`${it.series.title}, ${it.label}, ${it.sub}`}
                accessibilityActions={[{ name: 'delete', label: 'Retirer de « En cours »' }]}
                onAccessibilityAction={(e) => e.nativeEvent.actionName === 'delete' && remove(it.series.id, it.kind, it.series.title)}>
                <Cover palette={it.series.palette} image={it.series.image} width={56} height={78} radius={8} />
                <View style={{ flex: 1, gap: 4 }}>
                  <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                    <Chip kind={it.bridged ? 'bridge' : it.kind} label={it.bridged ? 'Suite de l’anime' : undefined} />
                  </View>
                  <Txt v="label" numberOfLines={1}>{it.series.title}</Txt>
                  <Txt v="small" tabular numberOfLines={1}>{it.label} · {it.sub}</Txt>
                  {it.progress > 0 && <View style={{ marginTop: 4 }}><Progress value={it.progress} color={kindColor(it.kind)} /></View>}
                </View>
              </Press>
            </ReanimatedSwipeable>
          </Animated.View>
        ))}
        {items.length > 0 && (
          <Animated.View layout={LinearTransition.duration(220)}>
            <Txt v="footnote" color={C.text3} style={{ textAlign: 'center' }}>Glisse vers la gauche pour retirer une série.</Txt>
          </Animated.View>
        )}
      </View>

      {/* Moves with the list above when a row is removed or restored, instead of jumping. */}
      <Animated.View layout={LinearTransition.duration(220)}>

      <SectionHeader title="Ma liste" />
      <View style={styles.grid}>
        {myList.length === 0 && (
          <View style={{ flex: 1 }}>
            <EmptyState compact icon="bookmark-outline" title="Ta liste est vide" text="Touche « Ma liste » sur la fiche d’une série pour la garder ici." />
          </View>
        )}
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
      </Animated.View>
    </ScrollView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  swipeAction: {
    width: 96, marginLeft: S.sm, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: '#D9434F',
    alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.sm, paddingRight: S.md, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, boxShadow: SHADOW.inset,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: S.md, paddingHorizontal: S.lg },
  dot: { width: 7, height: 7, borderRadius: 4 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm, paddingHorizontal: S.lg },
});
