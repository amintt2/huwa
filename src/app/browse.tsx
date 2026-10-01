// "Voir tout" of an Anime tab section: the full list as a paged grid, refinable with the shared
// filter sheet (sort, genres…), except "Récemment sortis" which is ordered by air date.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AnimeFiltersForm, AnimeGrid } from '@/components/anime-browse';
import { FilterSheet } from '@/components/filter-sheet';
import { IconButton, Txt } from '@/components/ui';
import { activePills, removePill, sectionDefs, type BrowseFilters, type SectionId } from '@/data/browse-query';
import { C, R, S } from '@/theme/tokens';

export default function Browse() {
  const { section } = useLocalSearchParams<{ section?: SectionId }>();
  const insets = useSafeAreaInsets();
  const def = useMemo(() => {
    const defs = sectionDefs(new Date());
    return defs.find((d) => d.id === section) ?? defs[0];
  }, [section]);
  const [filters, setFilters] = useState<BrowseFilters>(def.filters);
  const [sheet, setSheet] = useState(false);
  // Pills show what was changed from the section's own preset.
  const base = new Set(activePills(def.filters).map((p) => p.key + p.label));
  const pills = activePills(filters).filter((p) => !base.has(p.key + p.label));

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={[styles.top, { paddingTop: insets.top + S.sm }]}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
        <View style={{ flex: 1 }}>
          <Txt v="title" numberOfLines={1}>{def.title}</Txt>
          {def.subtitle && <Txt v="small" numberOfLines={1}>{def.subtitle}</Txt>}
        </View>
        {!def.aired && (
          <Pressable onPress={() => setSheet(true)} style={[styles.filterBtn, pills.length > 0 && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]} accessibilityRole="button" accessibilityLabel="Filtres">
            <Ionicons name="options-outline" size={20} color={pills.length ? C.accentText : C.text} />
          </Pressable>
        )}
      </View>
      <AnimeGrid
        filters={filters}
        aired={def.aired}
        pills={pills}
        onRemove={(k) => setFilters((f) => removePill(f, k))}
        onReset={() => setFilters(def.filters)}
        bottomInset={insets.bottom}
      />
      <FilterSheet visible={sheet} onClose={() => setSheet(false)} onReset={() => setFilters(def.filters)}>
        <AnimeFiltersForm value={filters} onChange={setFilters} />
      </FilterSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingBottom: S.sm },
  filterBtn: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: R.control, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
});
