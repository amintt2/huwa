// Anime catalog home (Anime tab): search + "Filtres" (sheet), then either the sections
// ("Continuer", "Tendances", "Mieux notés", "Populaires de la saison", "Récemment sortis",
// "Bientôt", each with "Voir tout") or, as soon as a search / filter is set, a paged 3-column
// grid. Built on the shared rails (components/rails.tsx) and filter sheet
// (components/filter-sheet.tsx), like the Manhwa tab.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, type Href } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
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
import { ChipGroup, FilterPills, FilterSection, FilterSheet, Stepper } from './filter-sheet';
import { gridRowLayout, PosterTile, Rail, RailHeader, useGridTile } from './rails';
import { Button, Txt } from './ui';

const THIS_YEAR = new Date().getFullYear();

// ---------- opening a card ----------

let opening = false;
async function open(item: BrowseItem) {
  if (opening) return;
  opening = true;
  try {
    router.push((await browseHref(item)) as Href);
  } catch {
    Alert.alert('Indisponible', 'Cet anime n’a pas encore d’épisode à regarder.');
  } finally {
    opening = false;
  }
}

export function AnimeTile({ item, width, showScore = true }: { item: BrowseItem; width: number; showScore?: boolean }) {
  return (
    <PosterTile
      title={item.title}
      image={item.image}
      palette={item.palette}
      width={width}
      rating={showScore ? item.score ?? undefined : undefined}
      badge={item.badge}
      onPress={() => open(item)}
      accessibilityLabel={`${item.title}${item.score ? `, note ${item.score}` : ''}`}
    />
  );
}

// ---------- search bar ----------

/** Search field + "Filtres" button, outside the lists so typing never loses focus. */
function SearchBar({ value, onChange, count, onFilters }: { value: string; onChange: (v: string) => void; count: number; onFilters: () => void }) {
  return (
    <View style={styles.searchRow}>
      <View style={styles.search}>
        <Ionicons name="search" size={16} color={C.text2} />
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder="Rechercher un anime"
          placeholderTextColor={C.text2}
          style={styles.input}
          returnKeyType="search"
          autoCorrect={false}
          accessibilityLabel="Rechercher un anime"
        />
        {!!value && (
          <Pressable onPress={() => onChange('')} hitSlop={10} accessibilityLabel="Effacer la recherche">
            <Ionicons name="close-circle" size={17} color={C.text2} />
          </Pressable>
        )}
      </View>
      <Pressable onPress={onFilters} style={[styles.filterBtn, count > 0 && styles.on]} accessibilityRole="button" accessibilityLabel={count ? `Filtres, ${count} actifs` : 'Filtres'}>
        <Ionicons name="options-outline" size={18} color={count ? C.accentText : C.text} />
        <Txt v="small" color={count ? C.accentText : C.text} style={F.semibold}>Filtres</Txt>
        {count > 0 && (
          <View style={styles.badge}>
            <Txt v="caption" color={C.onAccent} style={{ fontSize: 10 }}>{count}</Txt>
          </View>
        )}
      </Pressable>
    </View>
  );
}

// ---------- filter form (inside the shared sheet) ----------

export function AnimeFiltersForm({ value: f, onChange }: { value: BrowseFilters; onChange: (f: BrowseFilters) => void }) {
  const set = (p: Partial<BrowseFilters>) => onChange({ ...f, ...p });
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <>
      <FilterSection title="Trier par">
        <ChipGroup options={(Object.keys(SORT_LABEL) as BrowseSort[]).map((s) => ({ value: s, label: SORT_LABEL[s] }))} selected={(v) => f.sort === v} onToggle={(sort) => set({ sort })} />
      </FilterSection>
      <FilterSection
        title={`Genres${f.genres.length ? ` · ${f.genres.length}` : ''}`}
        right={f.genres.length ? <Pressable onPress={() => set({ genres: [] })} hitSlop={8}><Txt v="small" color={C.accentText}>Effacer</Txt></Pressable> : undefined}>
        <ChipGroup options={BROWSE_GENRES.map((g) => ({ value: g, label: GENRE_LABEL[g] }))} selected={(g) => f.genres.includes(g)} onToggle={(g) => set({ genres: toggle(f.genres, g) })} />
      </FilterSection>
      <FilterSection title="Statut">
        <ChipGroup
          options={[{ value: 'ALL', label: 'Tous' }, ...(Object.keys(STATUS_LABEL) as BrowseStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))]}
          selected={(v) => (f.status ?? 'ALL') === v}
          onToggle={(v) => set({ status: v === 'ALL' ? null : (v as BrowseStatus) })}
        />
      </FilterSection>
      <FilterSection title="Format">
        <ChipGroup
          options={(['TV', 'MOVIE', 'ONA', 'OVA', 'SPECIAL'] as BrowseFormat[]).map((v) => ({ value: v, label: FORMAT_LABEL[v] }))}
          selected={(v) => f.formats.includes(v)}
          onToggle={(v) => set({ formats: toggle(f.formats, v) })}
        />
      </FilterSection>
      <FilterSection title="Saison">
        <ChipGroup
          options={[{ value: 'ALL', label: 'Toutes' }, ...(Object.keys(SEASON_LABEL) as Season[]).map((s) => ({ value: s, label: SEASON_LABEL[s] }))]}
          selected={(v) => (f.season ?? 'ALL') === v}
          onToggle={(v) => set({ season: v === 'ALL' ? null : (v as Season), year: v !== 'ALL' && !f.year ? THIS_YEAR : f.year })}
        />
        <View style={styles.box}>
          <Stepper label="Année" value={f.year} min={1960} max={THIS_YEAR + 1} start={THIS_YEAR} onChange={(year) => set({ year })} emptyLabel="Toutes" />
        </View>
      </FilterSection>
      <FilterSection title="Note minimale">
        <ChipGroup
          options={[{ value: 0, label: 'Toutes' }, ...SCORE_STEPS.map((n) => ({ value: n, label: `★ ${n.toFixed(1).replace('.', ',')}+` }))]}
          selected={(v) => (f.minScore ?? 0) === v}
          onToggle={(v) => set({ minScore: v === 0 ? null : v })}
        />
      </FilterSection>
    </>
  );
}

// ---------- results grid (virtualized, infinite scroll) ----------

export function AnimeGrid({
  filters, aired, pills, onRemove, onReset, onSort, onBack, bottomInset = 0,
}: {
  filters: BrowseFilters;
  aired?: boolean;
  pills: { key: string; label: string }[];
  onRemove: (key: string) => void;
  onReset: () => void;
  onSort?: (s: BrowseSort) => void;
  onBack?: () => void;
  bottomInset?: number;
}) {
  const tileW = useGridTile(3);
  const res = useBrowse(filters, aired);
  const sorts = Object.keys(SORT_LABEL) as BrowseSort[];
  const toolbar = !!onBack || !!onSort;
  return (
    <FlatList
      data={res.items}
      key="grid"
      numColumns={3}
      keyExtractor={(s) => s.key}
      columnWrapperStyle={{ gap: S.md, paddingHorizontal: S.lg }}
      contentContainerStyle={{ gap: S.lg, paddingBottom: bottomInset + S.xxl }}
      keyboardDismissMode="on-drag"
      initialNumToRender={12}
      maxToRenderPerBatch={9}
      windowSize={7}
      getItemLayout={gridRowLayout(tileW, S.sm + (toolbar ? 34 : 0) + (pills.length ? 34 + S.md : 0) + S.lg)}
      onEndReachedThreshold={0.6}
      onEndReached={res.loadMore}
      ListHeaderComponent={
        <View style={{ gap: S.md, paddingTop: S.sm }}>
          <FilterPills pills={pills} onRemove={onRemove} onReset={onReset} />
          {toolbar && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: S.sm, paddingHorizontal: S.lg, alignItems: 'center' }}>
              {onBack && (
                <Pressable onPress={onBack} style={styles.back} accessibilityRole="button" accessibilityLabel="Retour à l’accueil">
                  <Ionicons name="chevron-back" size={14} color={C.text} />
                  <Txt v="small" color={C.text} style={F.semibold}>Accueil</Txt>
                </Pressable>
              )}
              {onSort && <Txt v="caption" style={{ marginLeft: S.xs }}>Trier</Txt>}
              {onSort &&
                sorts.map((s) => {
                  const on = filters.sort === s;
                  return (
                    <Pressable key={s} onPress={() => onSort(s)} style={[styles.sort, on && styles.on]} accessibilityRole="button" accessibilityState={{ selected: on }}>
                      <Txt v="small" color={on ? C.accentText : C.text2} style={F.semibold}>{SORT_LABEL[s]}</Txt>
                    </Pressable>
                  );
                })}
            </ScrollView>
          )}
        </View>
      }
      renderItem={({ item }) => <AnimeTile item={item} width={tileW} />}
      ListEmptyComponent={
        res.loading ? (
          <ActivityIndicator color={C.text2} style={{ marginTop: S.xxl }} />
        ) : (
          <View style={styles.empty}>
            <Txt v="label">{res.error ? 'Recherche impossible' : 'Aucun résultat'}</Txt>
            <Txt v="small" style={{ textAlign: 'center' }}>{res.error ? 'Vérifie ta connexion.' : pills.length ? 'Essaie d’enlever un filtre.' : 'Essaie un autre titre, ou son nom anglais ou japonais.'}</Txt>
            {res.error ? (
              <Button small variant="soft" icon="refresh" label="Réessayer" onPress={res.reload} />
            ) : pills.length ? (
              <Button small variant="soft" label="Effacer les filtres" onPress={onReset} />
            ) : null}
          </View>
        )
      }
      ListFooterComponent={res.loading && res.items.length ? <ActivityIndicator color={C.text2} style={{ marginVertical: S.lg }} /> : null}
    />
  );
}

// ---------- the tab ----------

function SectionRail({ def }: { def: SectionDef }) {
  const r = useBrowse(def.filters, def.aired);
  return (
    <Rail
      title={def.title}
      subtitle={def.subtitle}
      data={r.items.slice(0, 20)}
      loading={r.loading}
      error={r.error ? 'Hors ligne : section indisponible.' : undefined}
      keyOf={(i) => i.key}
      tileWidth={def.id === 'trending' ? 136 : 112}
      onMore={() => router.push({ pathname: '/browse', params: { section: def.id } })}
      renderTile={(i, width) => <AnimeTile item={i} width={width} showScore={def.id !== 'upcoming'} />}
    />
  );
}

export function AnimeHome() {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [filters, setFilters] = useState<BrowseFilters>(EMPTY_FILTERS);
  const [sheet, setSheet] = useState(false);
  // Debounced search text (AniList allows ~30 requests a minute).
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.query === text ? f : { ...f, query: text })), 350);
    return () => clearTimeout(t);
  }, [text]);
  const defs = useMemo(() => sectionDefs(new Date()), []);
  const cont = useContinueItems().filter((i) => i.kind === 'anime');
  const pills = activePills(filters);
  const showGrid = hasFilters(filters) || filters.query.trim().length > 0;
  const reset = () => setFilters({ ...EMPTY_FILTERS, query: filters.query });
  const backHome = () => {
    setFilters(EMPTY_FILTERS);
    setText('');
  };
  type Row = { id: string };
  const rows: Row[] = useMemo(() => [...(cont.length ? [{ id: 'continue' }] : []), ...defs.map((d) => ({ id: d.id }))], [cont.length, defs]);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingTop: insets.top + S.sm, gap: S.md, paddingBottom: S.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingHorizontal: S.lg }}>
          <View style={{ width: 5, height: 22, borderRadius: 3, backgroundColor: C.accentText }} />
          <Txt v="display" style={{ fontSize: 28 }}>Anime</Txt>
        </View>
        <SearchBar value={text} onChange={setText} count={pills.length} onFilters={() => setSheet(true)} />
      </View>
      {showGrid ? (
        <AnimeGrid
          filters={filters}
          pills={pills}
          onRemove={(k) => setFilters((f) => removePill(f, k))}
          onReset={reset}
          onSort={(sort) => setFilters((f) => ({ ...f, sort }))}
          onBack={backHome}
          bottomInset={insets.bottom}
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ gap: S.xl, paddingTop: S.md, paddingBottom: insets.bottom + S.xxl * 2 }}
          initialNumToRender={3}
          windowSize={5}
          keyboardDismissMode="on-drag"
          renderItem={({ item }) => {
            if (item.id === 'continue') {
              return (
                <View style={{ gap: S.sm }}>
                  <RailHeader title="Continuer" />
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: S.lg, gap: S.md }}>
                    {cont.slice(0, 12).map((c) => (
                      <ContinueCard key={c.key} item={c} width={200} />
                    ))}
                  </ScrollView>
                </View>
              );
            }
            return <SectionRail def={defs.find((d) => d.id === item.id)!} />;
          }}
        />
      )}
      <FilterSheet visible={sheet} onClose={() => setSheet(false)} onReset={reset}>
        <AnimeFiltersForm value={filters} onChange={setFilters} />
      </FilterSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingHorizontal: S.lg },
  search: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: 44, paddingHorizontal: S.md,
    borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  input: { flex: 1, color: C.text, ...F.regular, fontSize: 15, paddingVertical: 10 },
  filterBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: S.md,
    borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  on: { backgroundColor: C.accentSoft, borderColor: C.accentLine },
  badge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 32, paddingHorizontal: 10, borderRadius: R.pill, backgroundColor: C.elevated },
  sort: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 10, borderRadius: R.pill, borderWidth: 1, borderColor: C.border },
  empty: { alignItems: 'center', gap: S.sm, paddingTop: 60, paddingHorizontal: S.xl },
  box: { padding: S.md, borderRadius: R.card, backgroundColor: C.elevated, gap: S.xs },
});
