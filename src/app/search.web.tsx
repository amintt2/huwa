// Web search. Phones: the native screen (its own search field). From 768 px the shell's top bar
// is the search field and drives `?q=`; this page shows the results as a responsive poster grid
// (AniList, same query as the native screen), with the type filter and sort as chips.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, View, useWindowDimensions } from 'react-native';

import { ErrorState, FilterChip, StateView } from '@/components/states';
import { Cover, TypeBadge, Txt } from '@/components/ui';
import { palette } from '@/data/anilist';
import { openMedia, type MediaSummary, type SearchParams, type SearchSort, type SearchType } from '@/data/anilist-api';
import { useSearchResults } from '@/data/use-anilist';
import { PosterGridSkeleton } from '@/components/skeletons';
import { useT } from '@/i18n';
import { C, R, S } from '@/theme/tokens';
import { hoverRing, HoverPress } from '@/web/hover-press';
import { WIDE } from '@/web/viewport';

import type Screen from './search';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const NativeSearch: typeof Screen = require('./search.tsx').default;

const TYPES: { v: SearchType; label: string }[] = [
  { v: 'all', label: 'Tout' },
  { v: 'anime', label: 'Anime' },
  { v: 'manhwa', label: 'Manhwa' },
];
const SORTS: SearchSort[] = ['relevance', 'popularity', 'trending', 'score', 'recent'];
const TILE = 168;

export default function SearchWeb() {
  const { width } = useWindowDimensions();
  if (width < WIDE) return <NativeSearch />;
  return <WideSearch width={width} />;
}

function WideSearch({ width }: { width: number }) {
  const t = useT();
  const { q = '' } = useLocalSearchParams<{ q?: string }>();
  const [type, setType] = useState<SearchType>('all');
  const [sort, setSort] = useState<SearchSort>('relevance');
  const [opening, setOpening] = useState<number | null>(null);
  // Same query as the native screen, through the cache: results already seen show at once.
  const params: SearchParams = { query: q, type, genre: null, year: null, status: null, sort };
  const { results, busy, loading, failed, retry } = useSearchResults(params, { typing: 400, filters: 100 });
  const state = failed ? 'error' : loading ? 'loading' : 'ok';

  const pad = S.xxl;
  const cols = Math.max(3, Math.floor((width - pad * 2 + S.lg) / (TILE + S.lg)));
  const tile = Math.floor((width - pad * 2 - S.lg * (cols - 1)) / cols);

  const open = async (m: MediaSummary) => {
    if (m.unavailable || opening) return;
    setOpening(m.anilistId);
    try {
      router.push(await openMedia(m.anilistId, m.type));
    } catch {
      setOpening(null);
      return;
    }
    setOpening(null);
  };

  const header = (
    <View style={{ gap: S.md, paddingBottom: S.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        <Txt v="display" accessibilityRole="header" numberOfLines={1} style={{ flexShrink: 1 }}>
          {q ? `Résultats pour « ${q} »` : 'Populaire en ce moment'}
        </Txt>
        {busy && results && <ActivityIndicator color={C.text2} />}
      </View>
      <View style={styles.chips}>
        {TYPES.map((x) => (
          <FilterChip key={x.v} label={x.label} selected={type === x.v} onPress={() => setType(x.v)} />
        ))}
        <View style={styles.sep} />
        {SORTS.map((s) => (
          <FilterChip key={s} label={t(`search.sort.${s}`)} selected={sort === s} onPress={() => setSort(s)} />
        ))}
      </View>
    </View>
  );

  return (
    <FlatList
      key={cols}
      style={{ flex: 1, backgroundColor: C.bg }}
      data={state === 'error' ? [] : (results ?? [])}
      keyExtractor={(m) => `${m.type}-${m.anilistId}`}
      numColumns={cols}
      columnWrapperStyle={{ gap: S.lg }}
      contentContainerStyle={{ padding: pad, gap: S.xl }}
      ListHeaderComponent={header}
      ListEmptyComponent={
        state === 'error' ? (
          <ErrorState onRetry={retry} />
        ) : state === 'loading' ? (
          <PosterGridSkeleton cols={cols} rows={2} gap={S.lg} pad={0} width={tile} />
        ) : (
          <StateView icon="search-outline" title={t('search.empty')} body={t('search.emptyBody')} />
        )
      }
      renderItem={({ item: m }) => (
        <HoverPress
          onPress={() => open(m)}
          disabled={m.unavailable}
          style={{ width: tile, gap: 6, opacity: m.unavailable ? 0.5 : 1 }}
          accessibilityRole="button"
          accessibilityLabel={`${m.title}, ${m.type === 'ANIME' ? 'anime' : 'manhwa'}${m.unavailable ? `, ${t('search.notAired')}` : ''}`}>
          {({ hovered, focused }) => (
            <>
              <Cover palette={palette(m.color)} image={m.image} width={tile} height={Math.round(tile * 1.42)}>
                <TypeBadge kind={m.type === 'ANIME' ? 'anime' : 'manhwa'} />
                {m.score ? (
                  <View style={styles.score}>
                    <Ionicons name="star" size={9} color={C.star} />
                    <Txt v="footnote" color={C.text} tabular style={{ fontSize: 11, fontWeight: '700' }}>{(m.score / 10).toFixed(1)}</Txt>
                  </View>
                ) : null}
                {opening === m.anilistId && (
                  <View style={[StyleSheet.absoluteFill, styles.opening]}>
                    <ActivityIndicator color={C.text} />
                  </View>
                )}
                <View pointerEvents="none" style={hoverRing(hovered || focused)} />
              </Cover>
              <Txt v="label" numberOfLines={2} color={hovered ? C.white : C.text} style={{ fontSize: 14, lineHeight: 18 }}>{m.title}</Txt>
              <Txt v="footnote" color={C.text3} tabular numberOfLines={1}>
                {m.unavailable ? t('search.notAired') : [m.year, m.status ? t(`media.${m.status}`) : null].filter(Boolean).join(' · ')}
              </Txt>
            </>
          )}
        </HoverPress>
      )}
    />
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm, alignItems: 'center' },
  sep: { width: 1, height: 20, backgroundColor: C.border, marginHorizontal: 4 },
  opening: { backgroundColor: 'rgba(5,7,13,0.55)', alignItems: 'center', justifyContent: 'center' },
  score: {
    position: 'absolute', right: 6, top: 6, flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingVertical: 2, paddingHorizontal: 5, borderRadius: R.chip, backgroundColor: 'rgba(5,7,13,0.72)',
  },
});
