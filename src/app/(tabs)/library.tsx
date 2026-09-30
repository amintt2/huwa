import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Chip, Cover, Press, Progress, SectionHeader, Txt } from '@/components/ui';
import { getSeries } from '@/data/catalog';
import { useContinueItems } from '@/store/derived';
import { useStore } from '@/store/store';
import { C, S, kindColor } from '@/theme/tokens';

export default function Library() {
  const items = useContinueItems();
  const myList = useStore((s) => s.myList);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingTop: S.sm, paddingBottom: S.xxl }}>
      <Txt v="display" style={{ fontSize: 28, paddingHorizontal: S.lg }}>Bibliothèque</Txt>

      <SectionHeader title="En cours" />
      <View style={{ paddingHorizontal: S.lg, gap: S.md }}>
        {items.length === 0 && <Txt v="body">Rien en cours. Lance un épisode ou un chapitre.</Txt>}
        {items.map((it) => (
          <Press key={it.key} onPress={() => router.push(it.href)} style={styles.row}>
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
        ))}
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: 10, borderRadius: 16, backgroundColor: C.surface },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: S.md, paddingHorizontal: S.lg },
  dot: { width: 7, height: 7, borderRadius: 4 },
});
