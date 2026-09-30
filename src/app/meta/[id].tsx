// Generic detail page for an addon catalog item that has no AniList page in our catalog.
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fetchMeta, type MetaDetail } from '@/addons/protocol';
import { getAddonByBase } from '@/addons/registry';
import { Chip, Cover, IconButton, Txt } from '@/components/ui';
import type { Palette } from '@/data/catalog';
import { C, S } from '@/theme/tokens';

const NEUTRAL: Palette = ['#0C111C', '#141B2B', '#2F6BEB'];

export default function MetaScreen() {
  const insets = useSafeAreaInsets();
  const { id, type, addon, anilist } = useLocalSearchParams<{ id: string; type: string; addon: string; anilist?: string }>();
  const source = addon ? getAddonByBase(addon) : undefined;
  const key = `${addon}|${type}|${id}`;
  const [res, setRes] = useState<{ key: string; meta: MetaDetail | null; error: boolean }>({ key: '', meta: null, error: false });

  useEffect(() => {
    if (!addon || !type || !id) return;
    let cancelled = false;
    fetchMeta(addon, type, id)
      .then((meta) => !cancelled && setRes({ key, meta, error: !meta }))
      .catch(() => !cancelled && setRes({ key, meta: null, error: true }));
    return () => {
      cancelled = true;
    };
  }, [addon, type, id, key]);

  const loading = res.key !== key;
  const meta = res.key === key ? res.meta : null;
  const videos = (meta?.videos ?? []).slice().sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));

  const header = (
    <View style={{ gap: S.lg, padding: S.lg }}>
      <View style={{ flexDirection: 'row', gap: S.lg }}>
        <Cover palette={NEUTRAL} image={meta?.poster} width={120} height={170} />
        <View style={{ flex: 1, gap: S.sm }}>
          <Txt v="title">{meta?.name ?? id}</Txt>
          <View style={{ flexDirection: 'row', gap: S.xs, flexWrap: 'wrap' }}>
            {!!meta?.releaseInfo && <Chip kind="neutral" label={String(meta.releaseInfo)} />}
            {!!meta?.imdbRating && <Chip kind="neutral" label={`★ ${meta.imdbRating}`} />}
            {!!anilist && <Chip kind="accent" label={`AniList ${anilist}`} />}
          </View>
          {!!meta?.genres?.length && <Txt v="small">{meta.genres.slice(0, 4).join(' · ')}</Txt>}
          {source && <Txt v="small">Source : {source.manifest.name}</Txt>}
        </View>
      </View>
      {loading && <ActivityIndicator color={C.accentText} />}
      {!loading && res.error && <Txt v="small">Fiche indisponible chez cet addon.</Txt>}
      {!!meta?.description && <Txt v="body">{meta.description}</Txt>}
      {!!anilist && (
        <Txt v="small">
          Cette œuvre n’est pas dans le catalogue tendance de Huwa ; la fiche complète (pont épisode ↔ chapitre, lecteur) n’est disponible que pour les titres du catalogue.
        </Txt>
      )}
      {videos.length > 0 && <Txt v="section">Épisodes ({videos.length})</Txt>}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingBottom: S.sm }}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => (router.canGoBack() ? router.back() : router.replace('/discover' as Href))} />
        <Txt v="small" numberOfLines={1} style={{ flex: 1 }}>{meta?.name ?? ''}</Txt>
      </View>
      <FlatList
        data={videos}
        keyExtractor={(v) => v.id}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom: S.xxl }}
        renderItem={({ item }) => (
          <View style={{ flexDirection: 'row', gap: S.md, paddingHorizontal: S.lg, paddingVertical: S.sm, alignItems: 'center' }}>
            {item.thumbnail ? <Cover palette={NEUTRAL} image={item.thumbnail} width={96} height={54} radius={8} /> : null}
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="label" numberOfLines={1}>
                {item.episode != null ? `${item.season != null ? `S${item.season} · ` : ''}Ép. ${item.episode}` : item.title ?? item.name ?? item.id}
              </Txt>
              {!!(item.title ?? item.name) && item.episode != null && <Txt v="small" numberOfLines={1}>{item.title ?? item.name}</Txt>}
            </View>
          </View>
        )}
      />
    </View>
  );
}
