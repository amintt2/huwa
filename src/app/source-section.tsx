// "Voir tout" of a source's home section: paged 3-column grid.
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CloudflareButton, SourceErrorState, SourceIcon, useOpenSourceItem } from '@/components/paperback';
import { gridRowLayout, PosterTile, useGridTile } from '@/components/rails';
import { Button, IconButton, Txt } from '@/components/ui';
import { palette } from '@/data/anilist';
import { getSection, getSourceHome, loadSourceHome, sectionPage } from '@/manga-ext/discover';
import { isCloudflareError, sourceErrorText } from '@/manga-ext/cloudflare-core';
import { getInstalled } from '@/manga-ext/registry';
import type { ExtSearchItem } from '@/manga-ext/validate';
import { C, S } from '@/theme/tokens';

const PLACEHOLDER = palette(null);

export default function SourceSection() {
  const { key, section: sectionId } = useLocalSearchParams<{ key: string; section: string }>();
  const insets = useSafeAreaInsets();
  const tileW = useGridTile(3);
  const source = getInstalled(key);
  const { open, isOpening } = useOpenSourceItem();
  const [items, setItems] = useState<ExtSearchItem[]>([]);
  const [state, setState] = useState<{ loading: boolean; error?: string; blocked?: { url?: string }; next?: unknown; done: boolean }>({ loading: true, done: false });
  const [title, setTitle] = useState(() => getSection(key, sectionId)?.title ?? '');
  const busy = useRef(false);

  const load = useCallback(
    async (next?: unknown) => {
      if (busy.current) return;
      busy.current = true;
      setState((s) => ({ ...s, loading: true, error: undefined, blocked: undefined }));
      try {
        let section = getSection(key, sectionId);
        if (!section) {
          await loadSourceHome(key);
          section = getSection(key, sectionId);
        }
        if (!section) throw new Error('Section introuvable');
        setTitle(section.title);
        const page = await sectionPage(key, section, next);
        setItems((prev) => {
          const seen = new Set(prev.map((i) => i.mangaId));
          return [...prev, ...page.items.filter((i) => !seen.has(i.mangaId))];
        });
        setState({ loading: false, next: page.next, done: page.next === undefined || !page.items.length });
      } catch (e) {
        setState((s) => ({ ...s, loading: false, error: sourceErrorText(e), blocked: isCloudflareError(e) ? { url: e.url } : undefined }));
      } finally {
        busy.current = false;
      }
    },
    [key, sectionId],
  );

  useEffect(() => {
    load();
  }, [load]);

  const headers = getSourceHome(key).imageHeaders;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
      <View style={styles.head}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="title" numberOfLines={1}>{title || 'Section'}</Txt>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <SourceIcon source={source} size={16} />
            <Txt v="small" numberOfLines={1}>{source?.name ?? 'Source'}</Txt>
          </View>
        </View>
      </View>
      <FlatList
        data={items}
        numColumns={3}
        keyExtractor={(i) => i.mangaId}
        columnWrapperStyle={{ gap: S.md, paddingHorizontal: S.lg }}
        contentContainerStyle={{ gap: S.lg, paddingTop: S.sm, paddingBottom: insets.bottom + S.xxl }}
        getItemLayout={gridRowLayout(tileW, S.sm)}
        initialNumToRender={12}
        windowSize={7}
        onEndReachedThreshold={0.6}
        onEndReached={() => !state.done && !state.loading && !state.error && load(state.next)}
        renderItem={({ item }) => (
          <PosterTile
            title={item.title}
            image={item.image}
            imageHeaders={headers}
            palette={PLACEHOLDER}
            width={tileW}
            badge={item.subtitle}
            busy={isOpening(key, item.mangaId)}
            onPress={() => open(key, item)}
          />
        )}
        ListEmptyComponent={
          state.loading ? null : (
            state.error ? (
              <View style={{ paddingTop: 80 }}>
                <SourceErrorState sourceKey={key} error={state.error} blocked={state.blocked} onRetry={() => load(state.next)} />
              </View>
            ) : (
              <View style={styles.center}>
                <Txt v="label">Aucun titre</Txt>
              </View>
            )
          )
        }
        ListFooterComponent={
          state.loading ? (
            <ActivityIndicator color={C.text2} style={{ marginVertical: S.xl }} />
          ) : state.error && items.length ? (
            <View style={{ flexDirection: 'row', gap: S.sm, alignSelf: 'center', marginVertical: S.lg }}>
              {state.blocked && <CloudflareButton sourceKey={key} url={state.blocked.url} onVerified={() => load(state.next)} />}
              <Button small variant="soft" icon="refresh" label="Réessayer" onPress={() => load(state.next)} />
            </View>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingVertical: S.md },
  center: { alignItems: 'center', gap: S.sm, paddingTop: 80, paddingHorizontal: S.xl },
});
