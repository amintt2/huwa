// "Voir tout" of an Anime tab section: the full list as a virtualized grid, refinable with the
// same filter sheet (sort, genres…), except the "Récemment sortis" feed which is by air date.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { animeFilterGroups, BrowseGrid } from '@/components/anime-browse';
import { FilterPills, FilterSheet } from '@/components/filter-sheet';
import { IconButton, Txt } from '@/components/ui';
import { activePills, removePill, sectionDefs, type BrowseFilters, type SectionId } from '@/data/browse-query';
import { C, R, S } from '@/theme/tokens';

export default function Browse() {
  const { section } = useLocalSearchParams<{ section?: SectionId }>();
  const insets = useSafeAreaInsets();
  const def = useMemo(() => sectionDefs(new Date()).find((d) => d.id === section) ?? sectionDefs(new Date())[0], [section]);
  const [filters, setFilters] = useState<BrowseFilters>(def.filters);
  const [sheet, setSheet] = useState(false);
  // Pills show what was changed from the section's own preset.
  const base = new Set(activePills(def.filters).map((p) => p.key + p.label));
  const pills = activePills(filters).filter((p) => !base.has(p.key + p.label));

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingTop: insets.top + S.sm, gap: S.md, paddingBottom: S.sm }}>
        <View style={styles.top}>
          <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
          <View style={{ flex: 1 }}>
            <Txt v="title" numberOfLines={1}>{def.title}</Txt>
            {def.subtitle && <Txt v="small" numberOfLines={1}>{def.subtitle}</Txt>}
          </View>
          {!def.aired && (
            <Pressable onPress={() => setSheet(true)} style={styles.filterBtn} accessibilityRole="button" accessibilityLabel="Filtres">
              <Ionicons name="options-outline" size={20} color={pills.length ? C.accentText : C.text} />
            </Pressable>
          )}
        </View>
        <FilterPills pills={pills} onRemove={(k) => setFilters((f) => removePill(f, k))} onReset={() => setFilters(def.filters)} />
      </View>
      <BrowseGrid filters={filters} aired={def.aired} />
      <FilterSheet visible={sheet} groups={animeFilterGroups(filters, setFilters)} onClose={() => setSheet(false)} onReset={() => setFilters(def.filters)} />
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg },
  filterBtn: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: R.control, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
});
