// Generic detail page for an addon catalog item that has no AniList page in our catalog.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fetchMeta, type MetaDetail } from '@/addons/protocol';
import { getAddonByBase } from '@/addons/registry';
import { Button, Chip, Cover, IconButton, Press, Txt } from '@/components/ui';
import { openMedia } from '@/data/anilist-api';
import { getSeries, type Palette } from '@/data/catalog';
import { C, S } from '@/theme/tokens';

const NEUTRAL: Palette = ['#0C111C', '#141B2B', '#2F6BEB'];

/**
 * Episodes play from Huwa's series pages (sources, progress, comments). An addon item linked to
 * AniList opens there (fetched and added to the catalog if needed), on the tapped episode when it
 * exists; otherwise say why it can't be played instead of a row that does nothing.
 */
async function openEpisode(anilist: string | undefined, episode: number | undefined) {
  if (!anilist) {
    Alert.alert(
      'Lecture indisponible',
      'Cette fiche vient de l’addon et n’est reliée à aucune œuvre AniList : Huwa ne peut pas savoir quel épisode chercher. Cherche le titre dans Huwa pour le regarder.',
    );
    return;
  }
  try {
    const href = await openMedia(Number(anilist), 'ANIME');
    const ep = episode != null ? getSeries(`al${anilist}`)?.anime?.episodes.find((e) => e.number === episode) : undefined;
    router.push(ep ? (`/watch/${ep.id}` as Href) : (href as Href));
  } catch {
    Alert.alert('Fiche introuvable', 'AniList ne répond pas ou ne connaît pas cette œuvre. Réessaie plus tard.');
  }
}

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
        <Button variant="soft" icon="open-outline" label="Ouvrir la fiche Huwa" onPress={() => openEpisode(anilist, undefined)} />
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
          <Press
            // Later seasons are other AniList entries: open the series page rather than a wrong episode.
            onPress={() => openEpisode(anilist || undefined, (item.season ?? 1) <= 1 ? (item.episode ?? undefined) : undefined)}
            accessibilityRole="button"
            accessibilityLabel={item.episode != null ? `Épisode ${item.episode}` : (item.title ?? item.name ?? item.id)}
            style={{ flexDirection: 'row', gap: S.md, paddingHorizontal: S.lg, paddingVertical: S.sm, alignItems: 'center' }}>
            {item.thumbnail ? <Cover palette={NEUTRAL} image={item.thumbnail} width={96} height={54} radius={8} /> : null}
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="label" numberOfLines={1}>
                {item.episode != null ? `${item.season != null ? `S${item.season} · ` : ''}Ép. ${item.episode}` : item.title ?? item.name ?? item.id}
              </Txt>
              {!!(item.title ?? item.name) && item.episode != null && <Txt v="small" numberOfLines={1}>{item.title ?? item.name}</Txt>}
            </View>
            <Ionicons name={anilist ? 'play-circle-outline' : 'information-circle-outline'} size={22} color={C.text2} />
          </Press>
        )}
      />
    </View>
  );
}
