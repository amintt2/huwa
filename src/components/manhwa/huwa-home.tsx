// "Huwa" home of the Manhwa tab: search + "Filtres" (sheet), then either the AniList sections
// (Continuer, Tendances, Récemment mis à jour, Mieux notés, Populaires, Nouveautés) or, as soon
// as a search / filter / "Voir tout" is active, a paged 3-column grid of results.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, type Href } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ContinueCard } from '@/components/cards';
import { ChipGroup, FilterPills, FilterSection, FilterSheet, SearchFilterBar, Stepper } from '@/components/filter-sheet';
import { gridRowLayout, PosterTile, Rail, RailHeader, useGridTile } from '@/components/rails';
import { Button, Txt } from '@/components/ui';
import { openBrowseSeries, useBrowse, useManhwaHome, type BrowseSeries } from '@/data/manhwa-browse';
import {
  activeCount,
  DEFAULT_FILTERS,
  filterPills,
  GENRES,
  genreLabel,
  HOME_SECTIONS,
  ORIGIN_LABELS,
  removePill,
  resetFilters,
  SORT_LABELS,
  STATUS_LABELS,
  YEAR_MIN,
  type BrowseSort,
  type BrowseStatus,
  type MangaFilters,
  type Origin,
} from '@/data/manhwa-filters';
import { getSeries } from '@/data/catalog';
import { linkForTile, useLinkedSeries } from '@/manga-ext/link';
import { getInstalled } from '@/manga-ext/registry';
import { useContinueItems } from '@/store/derived';
import { C, F, R, S } from '@/theme/tokens';

const THIS_YEAR = new Date().getFullYear();
const open = (s: BrowseSeries) => router.push(openBrowseSeries(s) as Href);

/** Search field + "Filtres" button, kept outside the lists so typing never loses focus. */
export function HuwaSearchBar({ value, onChange, count, onFilters }: { value: string; onChange: (v: string) => void; count: number; onFilters: () => void }) {
  return <SearchFilterBar value={value} onChange={onChange} placeholder="Rechercher un manhwa" count={count} onFilters={onFilters} />;
}

export function useHuwaFilters() {
  const [filters, setFilters] = useState<MangaFilters>(DEFAULT_FILTERS);
  const [text, setText] = useState('');
  const [grid, setGrid] = useState(false);
  const [sheet, setSheet] = useState(false);
  // Debounced search text → filters.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.query === text ? f : { ...f, query: text })), 350);
    return () => clearTimeout(t);
  }, [text]);
  return { filters, setFilters, text, setText, grid, setGrid, sheet, setSheet };
}

export function HuwaHome({ state, bottomInset }: { state: ReturnType<typeof useHuwaFilters>; bottomInset: number }) {
  const { filters, setFilters, grid, setGrid, sheet, setSheet, setText } = state;
  const count = activeCount(filters);
  const showGrid = grid || count > 0 || !!filters.query.trim();
  const pills = filterPills(filters);
  const reset = () => {
    setFilters((f) => resetFilters(f));
  };
  const backHome = () => {
    setFilters(DEFAULT_FILTERS);
    setText('');
    setGrid(false);
  };

  return (
    <>
      {showGrid ? (
        <ResultsGrid filters={filters} bottomInset={bottomInset} pills={pills} onRemove={(k) => setFilters((f) => removePill(f, k))} onReset={reset} onSort={(sort) => setFilters((f) => ({ ...f, sort }))} onBack={backHome} />
      ) : (
        <HomeSections
          bottomInset={bottomInset}
          onMore={(sort) => {
            setFilters((f) => ({ ...f, sort }));
            setGrid(true);
          }}
        />
      )}
      <FilterSheet visible={sheet} onClose={() => setSheet(false)} onReset={reset}>
        <FiltersForm value={filters} onChange={setFilters} />
      </FilterSheet>
    </>
  );
}

/** "Disponible dans tes sources": the tile's series is linked to an installed source. */
function sourceBadge(linked: ReturnType<typeof useLinkedSeries>, s: { id: string; manhwaId?: number }) {
  const l = linkForTile(linked, s);
  return l ? `✓ ${getInstalled(l.key)?.name ?? 'Source'}` : undefined;
}

// ---------- sections ----------

function HomeSections({ bottomInset, onMore }: { bottomInset: number; onMore: (sort: BrowseSort) => void }) {
  const home = useManhwaHome();
  const cont = useContinueItems().filter((i) => i.kind === 'manhwa');
  const linked = useLinkedSeries();
  const inSources = useMemo(() => linked.flatMap((l) => (getSeries(l.seriesId)?.manhwa ? [{ link: l, series: getSeries(l.seriesId)! }] : [])).slice(0, 20), [linked]);
  type Row = { id: string };
  const rows: Row[] = useMemo(
    () => [...(cont.length ? [{ id: 'continue' }] : []), ...(inSources.length ? [{ id: 'sources' }] : []), ...HOME_SECTIONS.map((s) => ({ id: s.id }))],
    [cont.length, inSources.length],
  );

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.id}
      contentContainerStyle={{ gap: 28, paddingTop: S.md, paddingBottom: bottomInset + S.xxl }}
      initialNumToRender={3}
      windowSize={5}
      ListFooterComponent={home.error ? <Txt v="small" style={{ paddingHorizontal: S.lg, fontSize: 12 }}>Hors ligne : catalogue enregistré.</Txt> : null}
      renderItem={({ item }) => {
        if (item.id === 'continue') {
          return (
            <View style={{ gap: S.sm }}>
              <RailHeader title="Continuer" />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: S.lg, gap: S.md }}>
                {cont.slice(0, 12).map((c) => (
                  <ContinueCard key={c.key} item={c} width={208} badge={false} />
                ))}
              </ScrollView>
            </View>
          );
        }
        if (item.id === 'sources') {
          return (
            <Rail
              title="Dans tes sources"
              subtitle="Les vrais chapitres, prêts à lire"
              data={inSources}
              keyOf={(x) => x.series.id}
              tileWidth={112}
              renderTile={({ link, series }, width) => (
                <PosterTile
                  title={series.title}
                  image={series.image}
                  imageHeaders={series.id.startsWith('px') ? link.imageHeaders : undefined}
                  palette={series.palette}
                  width={width}
                  badge={`${getInstalled(link.key)?.name ?? 'Source'} · ${series.manhwa?.chapters.length ?? 0} ch.`}
                  onPress={() => router.push(`/manhwa/${series.id}` as Href)}
                  accessibilityLabel={`${series.title}, dans ${getInstalled(link.key)?.name ?? 'tes sources'}`}
                />
              )}
            />
          );
        }
        const section = HOME_SECTIONS.find((s) => s.id === item.id)!;
        const data = home.data?.[section.id] ?? [];
        return (
          <Rail
            title={section.title}
            data={data}
            loading={home.state === 'loading'}
            keyOf={(s) => s.id}
            tileWidth={section.id === 'trending' ? 136 : 112}
            onMore={() => onMore(section.sort)}
            renderTile={(s, width) => (
              <PosterTile
                title={s.title}
                image={s.image}
                palette={s.palette}
                width={width}
                rating={section.id === 'top' || section.id === 'trending' ? s.rating : undefined}
                badge={
                  sourceBadge(linked, s) ?? (section.id === 'updated' && s.status === 'ongoing' ? 'En cours' : section.id === 'fresh' && s.year ? String(s.year) : undefined)
                }
                onPress={() => open(s)}
              />
            )}
          />
        );
      }}
    />
  );
}

// ---------- results ----------

function ResultsGrid({
  filters,
  bottomInset,
  pills,
  onRemove,
  onReset,
  onSort,
  onBack,
}: {
  filters: MangaFilters;
  bottomInset: number;
  pills: { key: string; label: string }[];
  onRemove: (key: string) => void;
  onReset: () => void;
  onSort: (s: BrowseSort) => void;
  onBack: () => void;
}) {
  const tileW = useGridTile(3);
  const res = useBrowse(filters, true);
  const linked = useLinkedSeries();
  const sorts = Object.keys(SORT_LABELS) as BrowseSort[];

  return (
    <FlatList
      data={res.items}
      key="grid"
      numColumns={3}
      keyExtractor={(s) => s.id}
      columnWrapperStyle={{ gap: S.md, paddingHorizontal: S.lg }}
      contentContainerStyle={{ gap: S.lg, paddingBottom: bottomInset + S.xxl }}
      keyboardDismissMode="on-drag"
      initialNumToRender={12}
      maxToRenderPerBatch={9}
      windowSize={7}
      getItemLayout={gridRowLayout(tileW, S.sm + 34 + (pills.length ? 34 + S.md : 0) + S.lg)}
      onEndReachedThreshold={0.6}
      onEndReached={res.loadMore}
      ListHeaderComponent={
        <View style={{ gap: S.md, paddingTop: S.sm }}>
          <FilterPills pills={pills} onRemove={onRemove} onReset={onReset} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: S.sm, paddingHorizontal: S.lg, alignItems: 'center' }}>
            <Pressable onPress={onBack} style={styles.back} accessibilityRole="button" accessibilityLabel="Retour à l’accueil">
              <Ionicons name="chevron-back" size={14} color={C.text} />
              <Txt v="small" color={C.text} style={F.semibold}>Accueil</Txt>
            </Pressable>
            <Txt v="caption" style={{ marginLeft: S.xs }}>Trier</Txt>
            {sorts.map((s) => {
              const on = filters.sort === s;
              return (
                <Pressable key={s} onPress={() => onSort(s)} style={[styles.sort, on && styles.sortOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
                  <Txt v="small" color={on ? C.accentText : C.text2} style={F.semibold}>{SORT_LABELS[s]}</Txt>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      }
      renderItem={({ item: s }) => (
        <PosterTile title={s.title} image={s.image} palette={s.palette} width={tileW} rating={s.rating} badge={sourceBadge(linked, s)} onPress={() => open(s)} />
      )}
      ListEmptyComponent={
        res.loading ? (
          <ActivityIndicator color={C.text2} style={{ marginTop: S.xxl }} />
        ) : (
          <View style={styles.empty}>
            <Txt v="label">{res.error ? 'Recherche impossible' : 'Aucun résultat'}</Txt>
            <Txt v="small" style={{ textAlign: 'center' }}>{res.error ?? (pills.length ? 'Essaie d’enlever un filtre.' : 'Essaie un autre titre, ou ses noms anglais ou coréen.')}</Txt>
            {res.error ? (
              <Button small variant="soft" icon="refresh" label="Réessayer" onPress={res.retry} />
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

// ---------- the sheet ----------

function FiltersForm({ value: f, onChange }: { value: MangaFilters; onChange: (u: (f: MangaFilters) => MangaFilters) => void }) {
  const set = (p: Partial<MangaFilters>) => onChange((x) => ({ ...x, ...p }));
  const sorts = Object.keys(SORT_LABELS) as BrowseSort[];
  const origins: (Origin | null)[] = ['KR', 'CN', 'JP', null];
  const statuses = Object.keys(STATUS_LABELS) as BrowseStatus[];
  return (
    <>
      <FilterSection title="Trier par">
        <ChipGroup options={sorts.map((s) => ({ value: s, label: SORT_LABELS[s] }))} selected={(v) => f.sort === v} onToggle={(sort) => set({ sort })} />
      </FilterSection>
      <FilterSection title="Origine">
        <ChipGroup
          options={origins.map((o) => ({ value: o ?? 'ALL', label: o ? ORIGIN_LABELS[o] : 'Toutes' }))}
          selected={(v) => (f.origin ?? 'ALL') === v}
          onToggle={(v) => set({ origin: v === 'ALL' ? null : (v as Origin) })}
        />
      </FilterSection>
      <FilterSection
        title={`Genres${f.genres.length ? ` · ${f.genres.length}` : ''}`}
        right={f.genres.length ? <Pressable onPress={() => set({ genres: [] })} hitSlop={8}><Txt v="small" color={C.accentText}>Effacer</Txt></Pressable> : undefined}>
        <ChipGroup
          options={GENRES.map((g) => ({ value: g, label: genreLabel(g) }))}
          selected={(g) => f.genres.includes(g)}
          onToggle={(g) => set({ genres: f.genres.includes(g) ? f.genres.filter((x) => x !== g) : [...f.genres, g] })}
        />
      </FilterSection>
      <FilterSection title="Statut">
        <ChipGroup
          options={[{ value: 'ALL', label: 'Tous' }, ...statuses.map((s) => ({ value: s, label: STATUS_LABELS[s] }))]}
          selected={(v) => (f.status ?? 'ALL') === v}
          onToggle={(v) => set({ status: v === 'ALL' ? null : (v as BrowseStatus) })}
        />
      </FilterSection>
      <FilterSection title="Année de début">
        <View style={styles.box}>
          <Stepper label="De" value={f.yearFrom} min={YEAR_MIN} max={f.yearTo ?? THIS_YEAR} start={Math.min(f.yearTo ?? THIS_YEAR, 2015)} onChange={(yearFrom) => set({ yearFrom })} emptyLabel="Toutes" />
          <Stepper label="À" value={f.yearTo} min={f.yearFrom ?? YEAR_MIN} max={THIS_YEAR + 1} start={THIS_YEAR} onChange={(yearTo) => set({ yearTo })} emptyLabel="Toutes" />
        </View>
      </FilterSection>
      <FilterSection title="Note minimale">
        <ChipGroup
          options={[{ value: 0, label: 'Toutes' }, ...[6, 7, 8, 9].map((n) => ({ value: n, label: `★ ${n}+` }))]}
          selected={(v) => (f.minScore ?? 0) === v}
          onToggle={(v) => set({ minScore: v === 0 ? null : v })}
        />
      </FilterSection>
    </>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 32, paddingHorizontal: 10, borderRadius: R.pill, backgroundColor: C.elevated },
  sort: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 10, borderRadius: R.pill, borderWidth: 1, borderColor: C.border },
  sortOn: { backgroundColor: C.accentSoft, borderColor: C.accentLine },
  empty: { alignItems: 'center', gap: S.sm, paddingTop: 60, paddingHorizontal: S.xl },
  box: { padding: S.md, borderRadius: R.card, backgroundColor: C.elevated, gap: S.xs },
});
