// Home of one installed source inside the Manhwa tab: its sections as poster rails, "Voir tout"
// opens the paged grid (`/source-section`). Items open through `openSourceManga` (AniList page
// when the title matches, else a page of the source only).
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, type Href } from 'expo-router';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';

import { CloudflareButton, SourceErrorState, useOpenSourceItem } from '@/components/paperback';
import { PosterTile, Rail } from '@/components/rails';
import { Txt } from '@/components/ui';
import { palette } from '@/data/anilist';
import { loadSourceHome, useSourceHome } from '@/manga-ext/discover';
import { getInstalled } from '@/manga-ext/registry';
import type { ExtSearchItem, ExtSection } from '@/manga-ext/validate';
import { C, R, S } from '@/theme/tokens';

const PLACEHOLDER = palette(null);

export function SourceHome({ sourceKey, bottomInset }: { sourceKey: string; bottomInset: number }) {
  const home = useSourceHome(sourceKey);
  const { open, isOpening } = useOpenSourceItem();
  const source = getInstalled(sourceKey);

  if (home.state === 'error') {
    return <SourceErrorState sourceKey={sourceKey} error={home.error} blocked={home.blocked} onRetry={() => loadSourceHome(sourceKey, true)} />;
  }
  if (home.state === 'ok' && !home.sections.length) {
    return (
      <View style={styles.center}>
        <Ionicons name="albums-outline" size={36} color={C.text2} />
        <Txt v="label" style={{ textAlign: 'center' }}>Pas de page d’accueil</Txt>
        <Txt v="small" style={{ textAlign: 'center' }}>
          {`${source?.name ?? 'Cette source'} ne propose pas de sections. Cherche un titre dans l’onglet Huwa : il sera trouvé dans tes sources.`}
        </Txt>
      </View>
    );
  }
  // Some rows blocked by Cloudflare (the home itself loaded): one banner with the button.
  const blockedRow = Object.values(home.rows).find((r) => r.blocked)?.blocked;
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
      ListHeaderComponent={
        blockedRow ? (
          <View style={styles.banner}>
            <Ionicons name="cloud-outline" size={18} color={C.accentText} />
            <Txt v="small" style={{ flex: 1, fontSize: 13 }}>Certaines sections demandent une vérification Cloudflare.</Txt>
            <CloudflareButton sourceKey={sourceKey} url={blockedRow.url} onVerified={() => loadSourceHome(sourceKey, true)} />
          </View>
        ) : null
      }
      renderItem={({ item: s }) => {
        const row = home.rows[s.id];
        return (
          <Rail
            title={s.title}
            subtitle={s.subtitle}
            data={row?.items ?? []}
            loading={!row || row.state === 'loading'}
            error={row?.state === 'error' ? (row.blocked ? 'Vérification Cloudflare requise.' : row.error) : undefined}
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
  banner: { flexDirection: 'row', alignItems: 'center', gap: S.sm, marginHorizontal: S.lg, padding: S.md, borderRadius: R.card, backgroundColor: C.surface, borderWidth: 1, borderColor: C.accentLine },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: S.sm, paddingHorizontal: S.xl, paddingBottom: 80 },
});
