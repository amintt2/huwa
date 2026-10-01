// Anime catalog home (Anime tab): search, filter sheet with active pills, horizontal sections
// ("Continuer", "Tendances", "Mieux notés", "Populaires de la saison", "Récemment sortis",
// "Bientôt") each with "Voir tout", and a virtualized results grid when a search / filter is set.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { browseHref, useBrowse, type BrowseItem } from '@/data/browse';
import {
  activePills,
  BROWSE_GENRES,
  EMPTY_FILTERS,
  FORMAT_LABEL,
  GENRE_LABEL,
  hasFilters,
  removePill,
  SCORE_STEPS,
  SEASON_LABEL,
  sectionDefs,
  SORT_LABEL,
  STATUS_LABEL,
  type BrowseFilters,
  type BrowseFormat,
  type BrowseSort,
  type BrowseStatus,
  type Season,
  type SectionDef,
} from '@/data/browse-query';
import { useContinueItems } from '@/store/derived';
import { C, F, R, S } from '@/theme/tokens';

import { ContinueCard } from './cards';
import { FilterPills, FilterSheet, type FilterGroup } from './filter-sheet';
import { SectionRow } from './section-row';
import { Cover, TypeBadge, Txt } from './ui';

const ROW_CARD_W = 116;

// ---------- card ----------

let opening = false;
async function open(item: BrowseItem) {
  if (opening) return;
  opening = true;
  try {
    router.push((await browseHref(item)) as never);
  } catch {
    Alert.alert('Indisponible', 'Cet anime n’a pas encore d’épisode à regarder.');
  } finally {
    opening = false;
  }
}

export function BrowseCard({ item, width }: { item: BrowseItem; width: number }) {
  return (
    <Pressable onPress={() => open(item)} style={({ pressed }) => [{ width, gap: 8 }, pressed && { opacity: 0.8 }]} accessibilityRole="button" accessibilityLabel={`${item.title}${item.score ? `, note ${item.score}` : ''}`}>
      <Cover palette={item.palette} image={item.image} width={width} height={Math.round(width * 1.42)}>
        <TypeBadge kind="anime" />
        {item.score != null && (
          <View style={styles.score}>
            <Ionicons name="star" size={9} color={C.accentText} />
            <Txt v="caption" color={C.text} style={{ fontSize: 10 }}>{item.score.toFixed(1).replace('.', ',')}</Txt>
          </View>
        )}
        {item.badge && (
          <View style={styles.badge}>
            <Txt v="caption" color={C.onAccent} style={{ fontSize: 9 }}>{item.badge}</Txt>
          </View>
        )}
      </Cover>
      <Txt v="caption" color={C.text} numberOfLines={2} style={styles.title}>{item.title}</Txt>
    </Pressable>
  );
}

// ---------- filter groups ----------

export function animeFilterGroups(f: BrowseFilters, set: (f: BrowseFilters) => void, now = new Date()): FilterGroup[] {
  const y = now.getFullYear();
  return [
    {
      id: 'sort', title: 'Trier par', kind: 'single', value: f.sort,
      options: (Object.keys(SORT_LABEL) as BrowseSort[]).map((v) => ({ value: v, label: SORT_LABEL[v] })),
      onChange: (v) => set({ ...f, sort: (v ?? 'trending') as BrowseSort }),
    },
    {
      id: 'genres', title: 'Genres', kind: 'multi', value: f.genres,
      options: BROWSE_GENRES.map((g) => ({ value: g, label: GENRE_LABEL[g] })),
      onChange: (v) => set({ ...f, genres: v }),
    },
    {
      id: 'status', title: 'Statut', kind: 'single', allowNone: true, value: f.status,
      options: (Object.keys(STATUS_LABEL) as BrowseStatus[]).map((v) => ({ value: v, label: STATUS_LABEL[v] })),
      onChange: (v) => set({ ...f, status: v as BrowseStatus | null }),
    },
    {
      id: 'format', title: 'Format', kind: 'multi', value: f.formats,
      options: (['TV', 'MOVIE', 'ONA', 'OVA', 'SPECIAL'] as BrowseFormat[]).map((v) => ({ value: v, label: FORMAT_LABEL[v] })),
      onChange: (v) => set({ ...f, formats: v as BrowseFormat[] }),
    },
    {
      id: 'season', title: 'Saison', kind: 'single', allowNone: true, noneLabel: 'Toutes', value: f.season,
      options: (Object.keys(SEASON_LABEL) as Season[]).map((v) => ({ value: v, label: SEASON_LABEL[v] })),
      onChange: (v) => set({ ...f, season: v as Season | null, year: v && !f.year ? y : f.year }),
    },
    {
      id: 'year', title: 'Année', kind: 'single', allowNone: true, noneLabel: 'Toutes', value: f.year,
      options: Array.from({ length: 12 }, (_, i) => y + 1 - i).map((v) => ({ value: v, label: String(v) })),
      onChange: (v) => set({ ...f, year: v as number | null }),
    },
    {
      id: 'score', title: 'Note minimum', kind: 'single', allowNone: true, noneLabel: 'Toutes', value: f.minScore,
      options: SCORE_STEPS.map((v) => ({ value: v, label: `★ ${v.toFixed(1).replace('.', ',')}+` })),
      onChange: (v) => set({ ...f, minScore: v as number | null }),
    },
  ];
}

// ---------- results grid (virtualized, infinite scroll) ----------

export function BrowseGrid({ filters, aired, header, empty }: { filters: BrowseFilters; aired?: boolean; header?: ReactElement; empty?: string }) {
  const { width } = useWindowDimensions();
  const cols = width >= 700 ? 5 : 3;
  const cardW = Math.floor((width - S.lg * 2 - S.md * (cols - 1)) / cols);
  const r = useBrowse(filters, aired);
  return (
    <FlatList
      style={{ flex: 1, backgroundColor: C.bg }}
      data={r.items}
      key={cols}
      numColumns={cols}
      keyExtractor={(i) => i.key}
      columnWrapperStyle={{ gap: S.md, paddingHorizontal: S.lg }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ gap: S.lg, paddingTop: S.sm, paddingBottom: S.xxl * 2 }}
      keyboardDismissMode="on-drag"
      ListHeaderComponent={header}
      renderItem={({ item }) => <BrowseCard item={item} width={cardW} />}
      onEndReached={r.loadMore}
      onEndReachedThreshold={0.6}
      initialNumToRender={12}
      windowSize={7}
      removeClippedSubviews
      ListFooterComponent={r.loading && r.items.length ? <ActivityIndicator color={C.accentText} style={{ marginVertical: S.lg }} /> : null}
      ListEmptyComponent={
        r.loading ? (
          <ActivityIndicator color={C.accentText} style={{ marginTop: S.xxl }} />
        ) : r.error ? (
          <Pressable onPress={r.reload} style={{ padding: S.lg, alignItems: 'center', gap: S.sm }} accessibilityRole="button">
            <Txt v="body">Impossible de charger les résultats.</Txt>
            <Txt v="label" color={C.accentText}>Réessayer</Txt>
          </Pressable>
        ) : (
          <Txt v="body" style={{ paddingHorizontal: S.lg }}>{empty ?? 'Aucun anime ne correspond à ces filtres.'}</Txt>
        )
      }
    />
  );
}

// ---------- the tab ----------

function Section({ def }: { def: SectionDef }) {
  const r = useBrowse(def.filters, def.aired);
  return (
    <SectionRow
      title={def.title}
      subtitle={def.subtitle}
      items={r.items.slice(0, 20)}
      keyOf={(i) => i.key}
      renderItem={(i) => <BrowseCard item={i} width={ROW_CARD_W} />}
      itemWidth={ROW_CARD_W}
      itemHeight={Math.round(ROW_CARD_W * 1.42) + 40}
      loading={r.loading}
      error={r.error}
      onRetry={r.reload}
      onSeeAll={() => router.push({ pathname: '/browse', params: { section: def.id } })}
    />
  );
}

export function AnimeHome() {
  const insets = useSafeAreaInsets();
  const [input, setInput] = useState('');
  const [filters, setFilters] = useState<BrowseFilters>(EMPTY_FILTERS);
  const [sheet, setSheet] = useState(false);
  // Debounced search text (AniList allows ~30 requests a minute).
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.query === input ? f : { ...f, query: input })), 350);
    return () => clearTimeout(t);
  }, [input]);
  const defs = useMemo(() => sectionDefs(new Date()), []);
  const continueItems = useContinueItems().filter((i) => i.kind === 'anime');
  const pills = activePills(filters);
  const results = hasFilters(filters) || filters.query.trim().length > 0;
  const reset = () => {
    setFilters({ ...EMPTY_FILTERS, query: filters.query });
  };

  // Outside the lists: the search field keeps focus when the results grid replaces the sections.
  const header = (
    <View style={{ gap: S.md, paddingTop: insets.top + S.sm, paddingBottom: S.sm, backgroundColor: C.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingHorizontal: S.lg }}>
        <View style={{ width: 5, height: 22, borderRadius: 3, backgroundColor: C.accentText }} />
        <Txt v="display" style={{ fontSize: 28 }}>Anime</Txt>
      </View>
      <View style={{ flexDirection: 'row', gap: S.sm, paddingHorizontal: S.lg }}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color={C.text2} />
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Rechercher un anime"
            placeholderTextColor="#8A8AA0"
            style={styles.search}
            returnKeyType="search"
            accessibilityLabel="Rechercher un anime"
          />
          {!!input && (
            <Pressable onPress={() => setInput('')} hitSlop={10} accessibilityLabel="Effacer la recherche">
              <Ionicons name="close-circle" size={18} color={C.text2} />
            </Pressable>
          )}
        </View>
        <Pressable onPress={() => setSheet(true)} style={[styles.filterBtn, pills.length > 0 && { borderColor: C.accentLine, backgroundColor: C.accentSoft }]} accessibilityRole="button" accessibilityLabel={`Filtres${pills.length ? `, ${pills.length} actifs` : ''}`}>
          <Ionicons name="options-outline" size={20} color={pills.length ? C.accentText : C.text} />
          {pills.length > 0 && (
            <View style={styles.count}>
              <Txt v="caption" color={C.onAccent} style={{ fontSize: 10 }}>{pills.length}</Txt>
            </View>
          )}
        </Pressable>
      </View>
      <FilterPills pills={pills} onRemove={(k) => setFilters((f) => removePill(f, k))} onReset={reset} />
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {header}
      {results ? (
        <BrowseGrid filters={filters} />
      ) : (
        <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardDismissMode="on-drag" contentContainerStyle={{ gap: S.xl, paddingTop: S.md, paddingBottom: S.xxl * 2 }}>
          {continueItems.length > 0 && (
            <SectionRow
              title="Continuer"
              items={continueItems}
              keyOf={(i) => i.key}
              renderItem={(i) => <ContinueCard item={i} width={208} />}
              itemWidth={208}
              itemHeight={160}
            />
          )}
          {defs.map((d) => (
            <Section key={d.id} def={d} />
          ))}
        </ScrollView>
      )}
      <FilterSheet visible={sheet} groups={animeFilterGroups(filters, setFilters)} onClose={() => setSheet(false)} onReset={reset} />
    </View>
  );
}

const styles = StyleSheet.create({
  score: {
    position: 'absolute', right: 8, top: 8, flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingVertical: 3, paddingHorizontal: 6, borderRadius: R.chip, backgroundColor: 'rgba(5,7,13,0.72)',
  },
  badge: { position: 'absolute', left: 8, bottom: 8, paddingVertical: 3, paddingHorizontal: 6, borderRadius: R.chip, backgroundColor: C.accent },
  title: { textAlign: 'center', fontSize: 12, lineHeight: 15, ...F.heavy, letterSpacing: 0.5 },
  searchBox: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: 44, paddingHorizontal: S.md,
    borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  search: { flex: 1, color: C.text, ...F.regular, fontSize: 15, paddingVertical: 10 },
  filterBtn: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: R.control, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  count: { position: 'absolute', top: -5, right: -5, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center', backgroundColor: C.accent },
});
