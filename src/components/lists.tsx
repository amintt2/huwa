import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { getSeries } from '@/data/catalog';
import { useT } from '@/i18n';
import { useLists, type WatchStatus } from '@/store/lists';
import { C, S } from '@/theme/tokens';

import { Cover, Press, Txt } from './ui';

export const STATUS_ICON: Record<WatchStatus, 'time-outline' | 'play-circle-outline' | 'checkmark-circle-outline' | 'close-circle-outline'> = {
  planned: 'time-outline',
  watching: 'play-circle-outline',
  completed: 'checkmark-circle-outline',
  dropped: 'close-circle-outline',
};

/** Square button on series pages: opens the list / status sheet. Shows the current status icon. */
export function ListsButton({ seriesId, style }: { seriesId: string; style?: object }) {
  const t = useT();
  const status = useLists((s) => s.status[seriesId]);
  const inCustom = useLists((s) => s.lists.some((l) => l.seriesIds.includes(seriesId)));
  return (
    <Press
      onPress={() => router.push({ pathname: '/list-picker', params: { seriesId } })}
      style={[styles.square, style, (status || inCustom) && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}
      accessibilityRole="button"
      accessibilityLabel={status ? `${t('lists.addTo')} · ${t(`lists.status.${status}`)}` : t('lists.addTo')}>
      <Ionicons name={status ? STATUS_ICON[status] : 'albums-outline'} size={22} color={status || inCustom ? C.accentText : C.text} />
    </Press>
  );
}

/** Poster grid for a list of series ids (unknown ids are skipped). */
export function SeriesGrid({ ids }: { ids: string[] }) {
  const { width } = useWindowDimensions();
  const statuses = useLists((s) => s.status);
  const t = useT();
  const cols = 3;
  const w = Math.floor((width - S.lg * 2 - S.md * (cols - 1)) / cols);
  return (
    <View style={styles.grid}>
      {ids.map((id) => {
        const s = getSeries(id);
        if (!s) return null;
        const st = statuses[id];
        return (
          <Press
            key={id}
            onPress={() => router.push(s.anime ? `/anime/${id}` : `/manhwa/${id}`)}
            style={{ width: w, gap: 6 }}
            accessibilityLabel={st ? `${s.title}, ${t(`lists.status.${st}`)}` : s.title}>
            <Cover palette={s.palette} image={s.image} width={w} height={w * 1.42}>
              {st && (
                <View style={styles.status}>
                  <Ionicons name={STATUS_ICON[st]} size={14} color={C.accentText} />
                </View>
              )}
            </Cover>
            <Txt v="label" numberOfLines={1} style={{ fontSize: 13 }}>{s.title}</Txt>
            <View style={{ flexDirection: 'row', gap: 4 }}>
              {s.anime && <View style={[styles.dot, { backgroundColor: C.accentText }]} />}
              {s.manhwa && <View style={[styles.dot, { backgroundColor: C.accent }]} />}
            </View>
          </Press>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  square: {
    width: 52, height: 52, borderRadius: 16, backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'transparent',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: S.md, paddingHorizontal: S.lg },
  dot: { width: 7, height: 7, borderRadius: 4 },
  status: {
    position: 'absolute', right: 6, top: 6, width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(5,7,13,0.75)',
  },
});
