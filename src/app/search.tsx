import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ErrorState, FilterChip, LoadingView, ScreenHeader, StateView } from '@/components/states';
import { Cover, Press, TypeBadge, Txt } from '@/components/ui';
import { palette } from '@/data/anilist';
import {
  GENRES,
  openMedia,
  searchMedia,
  type MediaStatus,
  type MediaSummary,
  type SearchParams,
  type SearchSort,
  type SearchType,
} from '@/data/anilist-api';
import { genreLabel, useT, type Key } from '@/i18n';
import { useSettings } from '@/settings/settings';
import { C, F, R, S } from '@/theme/tokens';

const SORTS: SearchSort[] = ['relevance', 'popularity', 'trending', 'score', 'recent'];
const STATUSES: MediaStatus[] = ['RELEASING', 'FINISHED', 'NOT_YET_RELEASED', 'HIATUS', 'CANCELLED'];
const TYPES: { v: SearchType; key: Key }[] = [
  { v: 'all', key: 'search.type.all' },
  { v: 'anime', key: 'common.anime' },
  { v: 'manhwa', key: 'common.manhwa' },
];
const THIS_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: 16 }, (_, i) => THIS_YEAR + 1 - i);

const DEFAULTS: SearchParams = { query: '', type: 'all', genre: null, year: null, status: null, sort: 'relevance' };

export default function Search() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const t = useT();
  const { lang } = useSettings();

  const [params, setParams] = useState<SearchParams>(DEFAULTS);
  const [showFilters, setShowFilters] = useState(false);
  const [results, setResults] = useState<MediaSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState<number | null>(null);

  const update = (patch: Partial<SearchParams>) => setParams((p) => ({ ...p, ...patch }));
  const activeFilters = [params.genre, params.year, params.status].filter(Boolean).length;

  // Live search, debounced (AniList rate-limits), previous request aborted.
  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => {
        setLoading(true);
        setFailed(false);
        searchMedia(params, ctrl.signal)
          .then((list) => {
            setResults(list);
            setLoading(false);
          })
          .catch(() => {
            if (ctrl.signal.aborted) return;
            setFailed(true);
            setLoading(false);
          });
      },
      params.query ? 450 : 150,
    );
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [params, attempt]);

  const open = async (m: MediaSummary) => {
    if (m.unavailable || opening) return;
    setOpening(m.anilistId);
    try {
      const href = await openMedia(m.anilistId, m.type);
      router.push(href);
    } catch {
      Alert.alert(m.title, t('search.openError'));
    } finally {
      setOpening(null);
    }
  };

  const cols = 3;
  const cardW = Math.floor((width - S.lg * 2 - S.md * (cols - 1)) / cols);

  const header = (
    <View style={{ gap: S.md, paddingBottom: S.md }}>
      <View style={styles.inputWrap}>
        <Ionicons name="search" size={18} color={C.text2} />
        <TextInput
          value={params.query}
          onChangeText={(query) => update({ query })}
          placeholder={t('search.placeholder')}
          placeholderTextColor={C.text2}
          autoFocus
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          accessibilityLabel={t('search.title')}
          style={styles.input}
        />
        {loading && results !== null && <ActivityIndicator size="small" color={C.text2} />}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
        {TYPES.map((x) => (
          <FilterChip key={x.v} label={t(x.key)} selected={params.type === x.v} onPress={() => update({ type: x.v })} />
        ))}
        <View style={styles.sep} />
        <FilterChip
          icon="options-outline"
          label={activeFilters ? `${t('search.filters')} · ${activeFilters}` : t('search.filters')}
          selected={showFilters || activeFilters > 0}
          onPress={() => setShowFilters((v) => !v)}
        />
        {activeFilters > 0 && (
          <FilterChip icon="close" label={t('search.reset')} selected={false} onPress={() => update({ genre: null, year: null, status: null })} />
        )}
      </ScrollView>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
        <Txt v="caption" style={styles.rowLabel}>{t('search.sort')}</Txt>
        {SORTS.map((s) => (
          <FilterChip key={s} label={t(`search.sort.${s}`)} selected={params.sort === s} onPress={() => update({ sort: s })} />
        ))}
      </ScrollView>

      {showFilters && (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
            <Txt v="caption" style={styles.rowLabel}>{t('search.genre')}</Txt>
            <FilterChip label={t('search.genre.any')} selected={!params.genre} onPress={() => update({ genre: null })} />
            {GENRES.map((g) => (
              <FilterChip key={g} label={genreLabel(lang, g)} selected={params.genre === g} onPress={() => update({ genre: g })} />
            ))}
          </ScrollView>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
            <Txt v="caption" style={styles.rowLabel}>{t('search.year')}</Txt>
            <FilterChip label={t('search.year.any')} selected={!params.year} onPress={() => update({ year: null })} />
            {YEARS.map((y) => (
              <FilterChip key={y} label={String(y)} selected={params.year === y} onPress={() => update({ year: y })} />
            ))}
          </ScrollView>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
            <Txt v="caption" style={styles.rowLabel}>{t('search.status')}</Txt>
            <FilterChip label={t('search.status.any')} selected={!params.status} onPress={() => update({ status: null })} />
            {STATUSES.map((s) => (
              <FilterChip key={s} label={t(`media.${s}`)} selected={params.status === s} onPress={() => update({ status: s })} />
            ))}
          </ScrollView>
        </>
      )}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top + S.sm }}>
      <ScreenHeader title={t('search.title')} />
      <FlatList
        data={failed ? [] : (results ?? [])}
        keyExtractor={(m) => `${m.type}-${m.anilistId}`}
        numColumns={cols}
        columnWrapperStyle={{ gap: S.md, paddingHorizontal: S.lg }}
        contentContainerStyle={{ gap: S.lg, paddingBottom: insets.bottom + S.xxl }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListHeaderComponent={header}
        ListEmptyComponent={
          failed ? (
            <ErrorState onRetry={() => setAttempt((n) => n + 1)} />
          ) : loading ? (
            <LoadingView />
          ) : (
            <StateView icon="search-outline" title={t('search.empty')} body={t('search.emptyBody')} />
          )
        }
        renderItem={({ item: m }) => (
          <Press
            onPress={() => open(m)}
            style={{ width: cardW, gap: 6, opacity: m.unavailable ? 0.5 : 1 }}
            disabled={m.unavailable}
            accessibilityRole="button"
            accessibilityLabel={`${m.title}, ${m.type === 'ANIME' ? t('common.anime') : t('common.manhwa')}${m.unavailable ? `, ${t('search.notAired')}` : ''}`}>
            <Cover palette={palette(m.color)} image={m.image} width={cardW} height={cardW * 1.42}>
              <TypeBadge kind={m.type === 'ANIME' ? 'anime' : 'manhwa'} />
              {opening === m.anilistId && (
                <View style={[StyleSheet.absoluteFill, styles.opening]}>
                  <ActivityIndicator color={C.text} />
                </View>
              )}
              {m.score ? (
                <View style={styles.score}>
                  <Ionicons name="star" size={9} color={C.accentText} />
                  <Txt v="caption" color={C.text} style={{ fontSize: 10 }}>{(m.score / 10).toFixed(1)}</Txt>
                </View>
              ) : null}
            </Cover>
            <Txt v="caption" color={C.text} numberOfLines={2} style={{ fontSize: 11, lineHeight: 14, letterSpacing: 0.3 }}>{m.title}</Txt>
            <Txt v="small" numberOfLines={1} style={{ fontSize: 11 }}>
              {m.unavailable ? t('search.notAired') : [m.year, m.status ? t(`media.${m.status}`) : null].filter(Boolean).join(' · ')}
            </Txt>
          </Press>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  inputWrap: {
    marginHorizontal: S.lg, flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: 48,
    paddingHorizontal: 14, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface,
    borderWidth: 1, borderColor: C.border,
  },
  input: { flex: 1, color: C.text, fontSize: 16, ...F.medium, paddingVertical: 10 },
  chips: { paddingHorizontal: S.lg, gap: S.sm, alignItems: 'center' },
  rowLabel: { fontSize: 10, marginRight: 2 },
  sep: { width: 1, height: 20, backgroundColor: C.border, marginHorizontal: 2 },
  opening: { backgroundColor: 'rgba(5,7,13,0.55)', alignItems: 'center', justifyContent: 'center' },
  score: {
    position: 'absolute', right: 6, top: 6, flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingVertical: 2, paddingHorizontal: 5, borderRadius: R.chip, backgroundColor: 'rgba(5,7,13,0.72)',
  },
});
