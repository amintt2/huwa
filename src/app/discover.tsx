import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { idsForStremioId } from '@/addons/ids';
import { catalogGenres, genreRequired, type MetaPreview } from '@/addons/protocol';
import {
  catalogKey,
  useCatalogDefs,
  useCatalogRow,
  useCatalogSearch,
  type CatalogDef,
  type InstalledAddon,
} from '@/addons/registry';
import { Button, Cover, IconButton, Press, SectionHeader, Txt } from '@/components/ui';
import { getSeries, useCatalog, type Palette } from '@/data/catalog';
import { C, F, R, S } from '@/theme/tokens';

const NEUTRAL: Palette = ['#0C111C', '#141B2B', '#2F6BEB'];
const W = 116;

/** Opens our AniList page when the item maps to a series we know, else the generic addon meta page. */
async function openItem(addon: InstalledAddon, m: MetaPreview) {
  const ids = await idsForStremioId(m.id).catch(() => null);
  if (ids && getSeries(`al${ids.anilist}`)) {
    router.push(`/anime/al${ids.anilist}` as Href);
    return;
  }
  router.push({ pathname: '/meta/[id]', params: { id: m.id, type: m.type, addon: addon.baseUrl, anilist: ids?.anilist ? String(ids.anilist) : '' } } as Href);
}

export default function Discover() {
  const insets = useSafeAreaInsets();
  useCatalog();
  const defs = useCatalogDefs();
  const [query, setQuery] = useState('');
  const search = useCatalogSearch(query);
  const searching = query.trim().length >= 2;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: insets.top + S.sm, paddingBottom: S.xxl }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg }}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
        <Txt v="display" style={{ fontSize: 28 }}>Découvrir</Txt>
      </View>

      {search.searchable > 0 && (
        <View style={{ paddingHorizontal: S.lg, paddingTop: S.md }}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Rechercher dans les catalogues des addons"
            placeholderTextColor={C.text2}
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            style={styles.input}
            accessibilityLabel="Rechercher dans les catalogues des addons"
          />
        </View>
      )}

      {searching ? (
        <View>
          {search.hits.map((h) => (
            <View key={catalogKey(h)}>
              <SectionHeader title={`${h.catalog.name ?? h.catalog.id} · ${h.addon.manifest.name}`} />
              <Posters addon={h.addon} metas={h.metas} />
            </View>
          ))}
          {search.pending > 0 && <ActivityIndicator color={C.accentText} style={{ marginTop: S.lg }} />}
          {search.pending === 0 && search.hits.length === 0 && <Txt v="small" style={{ padding: S.lg }}>Aucun résultat.</Txt>}
        </View>
      ) : (
        <>
          {defs.length === 0 && (
            <View style={{ padding: S.lg, gap: S.md }}>
              <Txt v="body">Aucun catalogue. Installe un addon qui propose des catalogues (ressource « catalog »).</Txt>
              <Button variant="soft" icon="extension-puzzle-outline" label="Gérer les extensions" onPress={() => router.push('/addons' as Href)} />
            </View>
          )}
          {defs.map((d) => <CatalogRowView key={catalogKey(d)} def={d} />)}
        </>
      )}
    </ScrollView>
  );
}

function CatalogRowView({ def }: { def: CatalogDef }) {
  const genres = catalogGenres(def.catalog);
  const [genre, setGenre] = useState<string | undefined>(genreRequired(def.catalog) ? genres[0] : undefined);
  const row = useCatalogRow(def, genre);
  const choices = genreRequired(def.catalog) ? genres : [undefined, ...genres];

  return (
    <View>
      <SectionHeader title={`${def.catalog.name ?? def.catalog.id} · ${def.addon.manifest.name}`} />
      {genres.length > 0 && (
        <FlatList
          horizontal
          data={choices}
          keyExtractor={(g) => g ?? '__all'}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: S.lg, gap: S.sm, paddingBottom: S.sm }}
          renderItem={({ item }) => {
            const on = item === genre;
            return (
              <Press
                onPress={() => setGenre(item)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={[styles.genre, on && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
                <Txt v="small" color={on ? C.accentText : C.text} style={{ fontSize: 13 }}>{item ?? 'Tout'}</Txt>
              </Press>
            );
          }}
        />
      )}
      {row.state === 'loading' && <ActivityIndicator color={C.accentText} style={{ alignSelf: 'flex-start', marginLeft: S.lg }} />}
      {row.state === 'error' && <Txt v="small" style={{ paddingHorizontal: S.lg }}>Catalogue injoignable.</Txt>}
      {row.state === 'ok' && row.metas.length === 0 && <Txt v="small" style={{ paddingHorizontal: S.lg }}>Vide.</Txt>}
      <Posters addon={def.addon} metas={row.metas} onEnd={row.loadMore} loadingMore={row.busy} />
    </View>
  );
}

function Posters({ addon, metas, onEnd, loadingMore }: { addon: InstalledAddon; metas: MetaPreview[]; onEnd?: () => void; loadingMore?: boolean }) {
  const [opening, setOpening] = useState('');
  return (
    <FlatList
      horizontal
      data={metas}
      keyExtractor={(m) => m.id}
      showsHorizontalScrollIndicator={false}
      onEndReached={onEnd}
      onEndReachedThreshold={1.5}
      contentContainerStyle={{ paddingHorizontal: S.lg, gap: S.md }}
      ListFooterComponent={loadingMore ? <ActivityIndicator color={C.accentText} style={{ height: W * 1.42, marginLeft: S.sm }} /> : null}
      renderItem={({ item }) => (
        <Press
          style={{ width: W, gap: 8 }}
          accessibilityLabel={item.name}
          disabled={!!opening}
          onPress={() => {
            setOpening(item.id);
            openItem(addon, item).finally(() => setOpening(''));
          }}>
          <Cover palette={NEUTRAL} image={item.poster} width={W} height={W * 1.42} dim={opening === item.id}>
            {opening === item.id && <ActivityIndicator color={C.white} style={StyleSheet.absoluteFill} />}
          </Cover>
          <Txt v="caption" color={C.text} numberOfLines={2} style={{ fontSize: 11, lineHeight: 14 }}>{item.name}</Txt>
        </Press>
      )}
    />
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 44, paddingHorizontal: S.lg, borderRadius: R.card, backgroundColor: C.surface,
    color: C.text, ...F.medium, fontSize: 16,
  },
  genre: {
    minHeight: 32, paddingHorizontal: S.md, alignItems: 'center', justifyContent: 'center',
    borderRadius: R.control, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface,
  },
});
