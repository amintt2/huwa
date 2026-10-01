// UI pieces for manga sources (Paperback extensions): source results in search, the "source"
// panel of a manhwa page, and source icons.
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from 'react-native';

import { Button, Cover, Press, Txt } from '@/components/ui';
import { palette } from '@/data/anilist';
import type { Series } from '@/data/catalog';
import { useSourceSearch, type SourceResults } from '@/manga-ext/hooks';
import { openSourceManga, refreshLinked, setLinkLang, unlink, useSourceLink } from '@/manga-ext/link';
import { getInstalled, useMangaExt, type InstalledSource } from '@/manga-ext/registry';
import type { ExtSearchItem } from '@/manga-ext/validate';
import { isStoreBuild } from '@/config/channel';
import { C, F, R, S } from '@/theme/tokens';

const PLACEHOLDER = palette(null);
const REFRESH_AFTER = 15 * 60e3;

export function SourceIcon({ source, size = 28 }: { source?: Pick<InstalledSource, 'icon'>; size?: number }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size, borderRadius: size * 0.28, borderCurve: 'continuous' as const };
  if (!source?.icon || failed) {
    return (
      <View style={[box, { backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center' }]}>
        <Ionicons name="book-outline" size={size * 0.55} color={C.text2} />
      </View>
    );
  }
  return <Image source={source.icon} style={[box, { backgroundColor: C.elevated }]} onError={() => setFailed(true)} cachePolicy="memory-disk" />;
}

const langLabel = (l: string) => (l === 'unknown' ? '?' : l.toUpperCase());

/** Opens a source result: builds (or reuses) its Huwa page, then navigates to it. */
async function openResult(source: InstalledSource, item: ExtSearchItem, seriesId?: string) {
  const id = await openSourceManga(source.key, item.mangaId, { seriesId });
  router.push(`/manhwa/${id}` as Href);
}

function ResultCard({ source, item, width, busy, onPress, headers }: { source: InstalledSource; item: ExtSearchItem; width: number; busy: boolean; onPress: () => void; headers?: Record<string, string> }) {
  return (
    <Press onPress={onPress} style={{ width, gap: 6 }} accessibilityRole="button" accessibilityLabel={`${item.title}, ${source.name}`}>
      <Cover palette={PLACEHOLDER} image={item.image} imageHeaders={headers} width={width} height={width * 1.42}>
        {busy && (
          <View style={[StyleSheet.absoluteFill, styles.busy]}>
            <ActivityIndicator color={C.text} />
          </View>
        )}
      </Cover>
      <Txt v="caption" color={C.text} numberOfLines={2} style={{ fontSize: 11, lineHeight: 14, letterSpacing: 0.3 }}>{item.title}</Txt>
    </Press>
  );
}

/** "Dans tes sources" block of the search screen: one rail per installed source. */
export function SourceResultsRail({ query, cardWidth }: { query: string; cardWidth: number }) {
  const rows = useSourceSearch(query);
  const [opening, setOpening] = useState<string | null>(null);
  if (!rows.length) return null;

  const open = async (r: SourceResults, item: ExtSearchItem) => {
    if (opening) return;
    setOpening(`${r.source.key}|${item.mangaId}`);
    try {
      await openResult(r.source, item);
    } catch (e) {
      Alert.alert(item.title, e instanceof Error ? e.message : 'Impossible d’ouvrir ce titre');
    } finally {
      setOpening(null);
    }
  };

  return (
    <View style={{ gap: S.md, paddingBottom: S.md }}>
      <Txt v="caption" style={{ paddingHorizontal: S.lg }}>Dans tes sources</Txt>
      {rows.map((r) => (
        <View key={r.source.key} style={{ gap: S.sm }}>
          <View style={styles.railHead}>
            <SourceIcon source={r.source} size={20} />
            <Txt v="label" style={{ fontSize: 14, flexShrink: 1 }} numberOfLines={1}>{r.source.name}</Txt>
            {r.state === 'loading' && <ActivityIndicator size="small" color={C.text2} />}
            {r.state === 'ok' && <Txt v="small" style={{ fontSize: 12 }}>{r.items.length ? `${r.items.length} résultat${r.items.length > 1 ? 's' : ''}` : 'Aucun résultat'}</Txt>}
          </View>
          {r.state === 'error' && <Txt v="small" style={{ paddingHorizontal: S.lg, fontSize: 12 }} numberOfLines={2}>{r.error}</Txt>}
          {r.items.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: S.lg, gap: S.md }} keyboardShouldPersistTaps="handled">
              {r.items.map((item) => (
                <ResultCard key={item.mangaId} source={r.source} item={item} width={cardWidth} busy={opening === `${r.source.key}|${item.mangaId}`} headers={r.imageHeaders} onPress={() => open(r, item)} />
              ))}
            </ScrollView>
          )}
        </View>
      ))}
    </View>
  );
}

/** Source panel of a manhwa page: linked source (refresh, language, unlink) or "find in my sources". */
export function SourcePanel({ series }: { series: Series }) {
  const link = useSourceLink(series.id);
  const { installed } = useMangaExt();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const source = link ? getInstalled(link.key) : undefined;

  const refresh = async () => {
    if (busy || !link) return;
    setBusy(true);
    setError('');
    try {
      await refreshLinked(series.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Actualisation impossible');
    } finally {
      setBusy(false);
    }
  };

  // Stale chapter list: refresh quietly when the page opens.
  const updatedAt = link?.updatedAt;
  useEffect(() => {
    if (updatedAt === undefined || Date.now() - updatedAt < REFRESH_AFTER) return;
    const t = setTimeout(refresh, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.id, updatedAt]);

  if (link) {
    return (
      <View style={styles.panel}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
          <SourceIcon source={source} size={34} />
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="label" numberOfLines={1}>{source?.name ?? 'Source supprimée'}</Txt>
            <Txt v="small" numberOfLines={1} style={{ fontSize: 12 }}>
              {series.manhwa?.chapters.length ?? 0} chapitres · {langLabel(link.lang)}
              {link.title !== series.title ? ` · « ${link.title} »` : ''}
            </Txt>
          </View>
          {busy ? (
            <ActivityIndicator color={C.text2} />
          ) : (
            <Press onPress={refresh} style={styles.round} accessibilityLabel="Actualiser les chapitres">
              <Ionicons name="refresh" size={18} color={C.text} />
            </Press>
          )}
          <Press
            onPress={() =>
              Alert.alert('Délier la source ?', 'Les chapitres de la source ne seront plus affichés sur cette page.', [
                { text: 'Annuler', style: 'cancel' },
                { text: 'Délier', style: 'destructive', onPress: () => unlink(series.id) },
              ])
            }
            style={styles.round}
            accessibilityLabel="Délier la source">
            <Ionicons name="link-outline" size={18} color={C.text} />
          </Press>
        </View>
        {link.langs.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: S.sm }}>
            {link.langs.map((l) => {
              const on = l === link.lang;
              return (
                <Press key={l} onPress={() => setLinkLang(series.id, l)} accessibilityRole="button" accessibilityState={{ selected: on }}
                  style={[styles.lang, on && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
                  <Txt v="caption" color={on ? C.accentText : C.text2}>{langLabel(l)}</Txt>
                </Press>
              );
            })}
          </ScrollView>
        )}
        {!!error && <Txt v="small" color="#FF8A8A" style={{ fontSize: 12 }}>{error}</Txt>}
      </View>
    );
  }

  if (!installed.some((s) => s.enabled)) {
    // App Store flavor: no extensions to add.
    if (isStoreBuild) return null;
    return (
      <Press onPress={() => router.push('/manga-sources' as Href)} style={[styles.panel, { flexDirection: 'row', alignItems: 'center', gap: S.md }]}
        accessibilityRole="button" accessibilityLabel="Ajouter des extensions manhwa">
        <Ionicons name="extension-puzzle-outline" size={20} color={C.accentText} />
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="label" style={{ fontSize: 14 }}>Lire les vrais chapitres</Txt>
          <Txt v="small" style={{ fontSize: 12 }}>Ajoute un dépôt d’extensions Paperback et installe tes sources.</Txt>
        </View>
        <Ionicons name="chevron-forward" size={16} color={C.text2} />
      </Press>
    );
  }

  return (
    <View style={styles.panel}>
      {!searching ? (
        <Button small variant="soft" icon="search" label="Trouver dans mes sources" onPress={() => setSearching(true)} />
      ) : (
        <LinkPicker series={series} onClose={() => setSearching(false)} />
      )}
    </View>
  );
}

function LinkPicker({ series, onClose }: { series: Series; onClose: () => void }) {
  const rows = useSourceSearch(series.title, true, 0);
  const [opening, setOpening] = useState<string | null>(null);
  const pick = async (r: SourceResults, item: ExtSearchItem) => {
    if (opening) return;
    setOpening(`${r.source.key}|${item.mangaId}`);
    try {
      await openSourceManga(r.source.key, item.mangaId, { seriesId: series.id });
      onClose();
    } catch (e) {
      Alert.alert(item.title, e instanceof Error ? e.message : 'Impossible de lier ce titre');
    } finally {
      setOpening(null);
    }
  };
  return (
    <View style={{ gap: S.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Txt v="caption">Choisis le bon titre</Txt>
        <Press onPress={onClose} hitSlop={10} accessibilityLabel="Fermer">
          <Ionicons name="close" size={18} color={C.text2} />
        </Press>
      </View>
      {rows.map((r) => (
        <View key={r.source.key} style={{ gap: S.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
            <SourceIcon source={r.source} size={18} />
            <Txt v="small" style={{ ...F.semibold, fontSize: 13 }}>{r.source.name}</Txt>
            {r.state === 'loading' && <ActivityIndicator size="small" color={C.text2} />}
          </View>
          {r.state === 'error' && <Txt v="small" style={{ fontSize: 12 }}>{r.error}</Txt>}
          {r.state === 'ok' && !r.items.length && <Txt v="small" style={{ fontSize: 12 }}>Aucun résultat</Txt>}
          {r.items.slice(0, 5).map((item) => {
            const busy = opening === `${r.source.key}|${item.mangaId}`;
            return (
              <Press key={item.mangaId} onPress={() => pick(r, item)} style={styles.pickRow} accessibilityRole="button" accessibilityLabel={`Lier ${item.title}`}>
                <Cover palette={PLACEHOLDER} image={item.image} imageHeaders={r.imageHeaders} width={40} height={56} radius={8} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt v="label" numberOfLines={2} style={{ fontSize: 14 }}>{item.title}</Txt>
                  {!!item.subtitle && <Txt v="small" numberOfLines={1} style={{ fontSize: 12 }}>{item.subtitle}</Txt>}
                </View>
                {busy ? <ActivityIndicator color={C.text2} /> : <Ionicons name="link" size={16} color={C.accentText} />}
              </Press>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  busy: { backgroundColor: 'rgba(5,7,13,0.55)', alignItems: 'center', justifyContent: 'center' },
  railHead: { flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingHorizontal: S.lg },
  panel: { gap: S.md, padding: S.md, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  round: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center' },
  lang: { minHeight: 30, minWidth: 44, paddingHorizontal: S.md, alignItems: 'center', justifyContent: 'center', borderRadius: R.control, borderWidth: 1, borderColor: C.border, backgroundColor: C.elevated },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingVertical: 4 },
});
