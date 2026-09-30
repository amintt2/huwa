import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { idsForStremioId } from '@/addons/ids';
import type { MetaPreview } from '@/addons/protocol';
import { useAddonCatalogs, type InstalledAddon } from '@/addons/registry';
import { Button, Cover, IconButton, Press, SectionHeader, Txt } from '@/components/ui';
import { getSeries, useCatalog, type Palette } from '@/data/catalog';
import { C, S } from '@/theme/tokens';

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
  const rows = useAddonCatalogs();
  const [opening, setOpening] = useState('');

  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.bg }} contentContainerStyle={{ paddingTop: insets.top + S.sm, paddingBottom: S.xxl }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg }}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
        <Txt v="display" style={{ fontSize: 28 }}>Découvrir</Txt>
      </View>

      {rows.length === 0 && (
        <View style={{ padding: S.lg, gap: S.md }}>
          <Txt v="body">Aucun catalogue. Installe un addon qui propose des catalogues (ressource « catalog »).</Txt>
          <Button variant="soft" icon="extension-puzzle-outline" label="Gérer les addons" onPress={() => router.push('/addons' as Href)} />
        </View>
      )}

      {rows.map((row) => (
        <View key={`${row.addon.baseUrl}|${row.catalog.type}|${row.catalog.id}`}>
          <SectionHeader title={`${row.catalog.name ?? row.catalog.id} · ${row.addon.manifest.name}`} />
          {row.state === 'loading' && <ActivityIndicator color={C.accentText} style={{ alignSelf: 'flex-start', marginLeft: S.lg }} />}
          {row.state === 'error' && <Txt v="small" style={{ paddingHorizontal: S.lg }}>Catalogue injoignable.</Txt>}
          {row.state === 'ok' && row.metas.length === 0 && <Txt v="small" style={{ paddingHorizontal: S.lg }}>Vide.</Txt>}
          <FlatList
            horizontal
            data={row.metas.slice(0, 40)}
            keyExtractor={(m) => m.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: S.lg, gap: S.md }}
            renderItem={({ item }) => (
              <Press
                style={{ width: W, gap: 8 }}
                accessibilityLabel={item.name}
                disabled={!!opening}
                onPress={() => {
                  setOpening(item.id);
                  openItem(row.addon, item).finally(() => setOpening(''));
                }}>
                <Cover palette={NEUTRAL} image={item.poster} width={W} height={W * 1.42} dim={opening === item.id}>
                  {opening === item.id && <ActivityIndicator color={C.white} style={StyleSheet.absoluteFill} />}
                </Cover>
                <Txt v="caption" color={C.text} numberOfLines={2} style={{ fontSize: 11, lineHeight: 14 }}>{item.name}</Txt>
              </Press>
            )}
          />
        </View>
      ))}
    </ScrollView>
  );
}
