// Home of one installed source inside the Manhwa tab: its sections as poster rails, "Voir tout"
// opens the paged grid (`/source-section`). Items open through `openSourceManga` (AniList page
// when the title matches, else a page of the source only).
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, type Href } from 'expo-router';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';

import { useOpenSourceItem } from '@/components/paperback';
import { PosterTile, Rail } from '@/components/rails';
import { Button, Txt } from '@/components/ui';
import { palette } from '@/data/anilist';
import { loadSourceHome, useSourceHome } from '@/manga-ext/discover';
import { getInstalled } from '@/manga-ext/registry';
import type { ExtSearchItem, ExtSection } from '@/manga-ext/validate';
import { C, S } from '@/theme/tokens';

const PLACEHOLDER = palette(null);

export function SourceHome({ sourceKey, bottomInset }: { sourceKey: string; bottomInset: number }) {
  const home = useSourceHome(sourceKey);
  const { open, isOpening } = useOpenSourceItem();
  const source = getInstalled(sourceKey);

  if (home.state === 'error' || (home.state === 'ok' && !home.sections.length)) {
    return (
      <View style={styles.center}>
        <Ionicons name={home.state === 'error' ? 'cloud-offline-outline' : 'albums-outline'} size={36} color={C.text2} />
        <Txt v="label" style={{ textAlign: 'center' }}>{home.state === 'error' ? 'Source indisponible' : 'Pas de page d’accueil'}</Txt>
        <Txt v="small" style={{ textAlign: 'center' }}>
          {home.state === 'error' ? home.error : `${source?.name ?? 'Cette source'} ne propose pas de sections. Cherche un titre dans l’onglet Huwa : il sera trouvé dans tes sources.`}
        </Txt>
        {home.state === 'error' && <Button small variant="soft" icon="refresh" label="Réessayer" onPress={() => loadSourceHome(sourceKey, true)} />}
      </View>
    );
  }
  if (home.state !== 'ok') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={C.text2} />
        <Txt v="small">Chargement de {source?.name ?? 'la source'}…</Txt>
      </View>
    );
  }

  const tile = (s: ExtSection, item: ExtSearchItem, width: number) => (
    <PosterTile
      title={item.title}
      image={item.image}
      imageHeaders={home.imageHeaders}
      palette={PLACEHOLDER}
      width={width}
      badge={item.subtitle}
      busy={isOpening(sourceKey, item.mangaId)}
      onPress={() => open(sourceKey, item)}
      accessibilityLabel={`${item.title}${item.subtitle ? `, ${item.subtitle}` : ''}, ${s.title}`}
    />
  );

  return (
    <FlatList
      data={home.sections}
      keyExtractor={(s) => s.id}
      contentContainerStyle={{ gap: S.xl, paddingTop: S.md, paddingBottom: bottomInset + S.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => loadSourceHome(sourceKey, true)} tintColor={C.text2} />}
      initialNumToRender={4}
      windowSize={5}
      renderItem={({ item: s }) => {
        const row = home.rows[s.id];
        return (
          <Rail
            title={s.title}
            subtitle={s.subtitle}
            data={row?.items ?? []}
            loading={!row || row.state === 'loading'}
            error={row?.state === 'error' ? row.error : undefined}
            empty="Aucun titre."
            tileWidth={s.kind === 'featured' || s.kind === 'large' ? 140 : 112}
            keyOf={(i) => i.mangaId}
            renderTile={(item, width) => tile(s, item, width)}
            onMore={s.more ? () => router.push({ pathname: '/source-section', params: { key: sourceKey, section: s.id } } as unknown as Href) : undefined}
          />
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: S.sm, paddingHorizontal: S.xl, paddingBottom: 80 },
});
