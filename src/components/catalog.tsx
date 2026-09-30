import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';

import { allSeries, useCatalog } from '@/data/catalog';
import { C, F, R, S, kindColor, kindSoft, type Kind } from '@/theme/tokens';

import { PosterCard } from './cards';
import { Txt } from './ui';

/** Shared catalog grid for the Anime and Manhwa tabs: same layout, section accent differs. */
export function Catalog({ kind }: { kind: Kind }) {
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [genre, setGenre] = useState<string | null>(null);
  useCatalog();
  const all = allSeries().filter((s) => (kind === 'anime' ? s.anime : s.manhwa));
  const genres = [...new Set(all.flatMap((s) => s.genres))];
  const items = all.filter(
    (s) => (!genre || s.genres.includes(genre)) && s.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const cols = 3;
  const cardW = Math.floor((width - S.lg * 2 - S.md * (cols - 1)) / cols);

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: C.bg }}
      data={items}
      key={cols}
      numColumns={cols}
      keyExtractor={(s) => s.id}
      columnWrapperStyle={{ gap: S.md, paddingHorizontal: S.lg }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ gap: S.lg, paddingTop: S.sm, paddingBottom: S.xxl }}
      ListHeaderComponent={
        <View style={{ paddingHorizontal: S.lg, gap: S.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
            <View style={{ width: 5, height: 22, borderRadius: 3, backgroundColor: kindColor(kind) }} />
            <Txt v="display" style={{ fontSize: 28 }}>{kind === 'anime' ? 'Anime' : 'Manhwa'}</Txt>
          </View>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={kind === 'anime' ? 'Rechercher un anime' : 'Rechercher un manhwa'}
            placeholderTextColor="#8A8AA0"
            style={styles.search}
            accessibilityLabel="Rechercher"
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: S.sm }}>
            {[null, ...genres].map((g) => {
              const on = genre === g;
              return (
                <Pressable
                  key={g ?? 'all'}
                  onPress={() => setGenre(g)}
                  style={[styles.pill, { backgroundColor: on ? kindSoft(kind) : C.elevated }]}>
                  <Txt v="small" color={on ? kindColor(kind) : C.text2} style={{ ...F.semibold }}>{g ?? 'Tous'}</Txt>
                </Pressable>
              );
            })}
          </View>
        </View>
      }
      renderItem={({ item }) => <PosterCard series={item} kind={kind} width={cardW} />}
      ListEmptyComponent={<Txt v="body" style={{ paddingHorizontal: S.lg }}>Aucun résultat.</Txt>}
    />
  );
}

const styles = StyleSheet.create({
  search: {
    minHeight: 44, paddingHorizontal: S.lg, borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
    color: C.text, ...F.regular, fontSize: 14,
  },
  pill: { minHeight: 34, justifyContent: 'center', paddingHorizontal: S.md, borderRadius: R.control, borderCurve: 'continuous', borderWidth: 1, borderColor: C.border },
});
