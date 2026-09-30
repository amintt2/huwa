import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cancelDownload, downloadChapter, downloadsSupported, useDownload } from '@/components/reader/downloads';
import { prefetchChapterStart, prefetchPages, usePages } from '@/components/reader/pages';
import { getPosition, readerReady, savePosition, setReaderMode, useReaderMode } from '@/components/reader/position';
import { ZoomLayer } from '@/components/reader/ZoomLayer';
import { Button, Press, Progress, Txt } from '@/components/ui';
import { animeEndChapter, episodeForChapter } from '@/data/bridge';
import { chapterLabel, getChapter, PAGE_ASPECT } from '@/data/catalog';
import { useThread } from '@/store/derived';
import { getState, saveChapterProgress } from '@/store/store';
import { C, R, S } from '@/theme/tokens';

const PREFETCH_AHEAD = 4;

export default function Read() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!getChapter(id)) return <Txt style={{ padding: S.xl }}>Chapitre introuvable.</Txt>;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Reader key={id} id={id} />
    </GestureHandlerRootView>
  );
}

/** Index of the last offset <= y. */
function pageAt(offsets: number[], y: number) {
  let lo = 0;
  let hi = offsets.length - 1;
  let at = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= y) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return at;
}

function Reader({ id }: { id: string }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { series, chapter } = getChapter(id)!;
  const chapters = series.manhwa!.chapters;
  const prev = chapters[chapter.number - 2];
  const next = chapters[chapter.number];
  const mode = useReaderMode();
  const paged = mode === 'paged';

  const { pages, origin, loading, headers } = usePages(id);
  const download = useDownload(id);
  const count = useThread(`ch:${id}`).length;

  const [aspects, setAspects] = useState<Record<string, number>>({});
  const [page, setPage] = useState(0);
  const [bars, setBars] = useState(true);
  const [zoomed, setZoomed] = useState(false);
  const [toastHidden, setToastHidden] = useState(false);
  const list = useRef<FlatList<string>>(null);
  const lastSave = useRef(0);
  const restored = useRef(false);
  const nextWarmed = useRef(false);

  const adaptedBy = episodeForChapter(series, chapter.number);
  const isContinuation = !!series.anime && chapter.number === animeEndChapter(series) + 1;

  // Layout of the vertical strip: real image ratios once known, the catalog ratio before.
  const { heights, offsets, total } = useMemo(() => {
    const h = pages.map((u) => width / (aspects[u] ?? PAGE_ASPECT));
    const o: number[] = [];
    let acc = 0;
    for (const x of h) {
      o.push(acc);
      acc += x;
    }
    return { heights: h, offsets: o, total: acc };
  }, [pages, aspects, width]);

  const headerSig = JSON.stringify(headers ?? {});
  const imageSource = (uri: string) => (headers && /^https?:/i.test(uri) ? { uri, headers } : { uri });

  // ---------- resume at the exact page ----------
  useEffect(() => {
    if (!pages.length || restored.current) return;
    let alive = true;
    readerReady.then(() => {
      if (!alive || restored.current) return;
      restored.current = true;
      let pos = getPosition(id);
      if (!pos) {
        const saved = getState().chapters[id];
        if (saved && !saved.done && saved.ratio > 0.05) pos = { page: Math.floor(saved.ratio * (pages.length - 1)), offset: 0 };
      }
      if (!pos || pos.page >= pages.length) return;
      const target = pos;
      requestAnimationFrame(() => {
        if (paged) list.current?.scrollToOffset({ offset: target.page * width, animated: false });
        else list.current?.scrollToOffset({ offset: offsets[target.page] + target.offset * heights[target.page], animated: false });
        setPage(target.page);
      });
    });
    return () => {
      alive = false;
    };
    // Layout values are read once, at restore time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length, id]);

  // ---------- preload the next pages / next chapter ----------
  useEffect(() => {
    if (!pages.length) return;
    prefetchPages(pages.slice(page + 1, page + 1 + PREFETCH_AHEAD), headerSig === '{}' ? undefined : JSON.parse(headerSig));
    if (next && !nextWarmed.current && page >= pages.length - 3) {
      nextWarmed.current = true;
      prefetchChapterStart(next.id).catch(() => {});
    }
  }, [page, pages, headerSig, next]);

  const record = (p: number, offset: number, ratio: number) => {
    if (p !== page) setPage(p);
    if (Date.now() - lastSave.current < 600) return;
    lastSave.current = Date.now();
    savePosition(id, { page: p, offset });
    saveChapterProgress(id, ratio);
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!pages.length) return;
    const { contentOffset, layoutMeasurement } = e.nativeEvent;
    if (paged) {
      const p = Math.min(pages.length - 1, Math.max(0, Math.round(contentOffset.x / width)));
      const atEnd = contentOffset.x >= pages.length * width - 1;
      record(p, 0, atEnd ? 1 : (p + 1) / pages.length);
      return;
    }
    const y = Math.max(0, contentOffset.y);
    const p = Math.min(pages.length - 1, pageAt(offsets, y + 1));
    const offset = Math.min(1, Math.max(0, (y - offsets[p]) / heights[p]));
    record(p, offset, Math.min(1, (y + layoutMeasurement.height) / Math.max(1, total)));
  };

  const goTo = (p: number) => {
    const target = Math.max(0, Math.min(pages.length - 1, p));
    if (paged) list.current?.scrollToOffset({ offset: target * width, animated: true });
    else list.current?.scrollToOffset({ offset: offsets[target], animated: true });
  };

  const switchMode = () => {
    setReaderMode(paged ? 'vertical' : 'paged');
    savePosition(id, { page, offset: 0 });
    setZoomed(false);
  };

  // Re-apply the current page after the list is rebuilt for the other mode.
  const firstMode = useRef(mode);
  useEffect(() => {
    if (firstMode.current === mode) return;
    firstMode.current = mode;
    const t = setTimeout(() => {
      if (mode === 'paged') list.current?.scrollToOffset({ offset: page * width, animated: false });
      else list.current?.scrollToOffset({ offset: offsets[page] ?? 0, animated: false });
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const openComments = () => router.push({ pathname: '/comments', params: { target: `ch:${id}`, kind: 'manhwa' } });
  const onImageLoad = (uri: string, w: number, h: number) => {
    if (!w || !h) return;
    const r = w / h;
    if (Math.abs((aspects[uri] ?? PAGE_ASPECT) - r) > 0.01) setAspects((a) => ({ ...a, [uri]: r }));
  };

  const footer = (
    <View style={[styles.footer, paged ? { width, height, justifyContent: 'center', paddingTop: insets.top + 60 } : { minHeight: height * 0.8, paddingBottom: insets.bottom + 140 }]}>
      <Txt v="caption" color={C.accentText}>FIN DU CHAPITRE {chapter.number}</Txt>
      <Txt v="title">{chapterLabel(chapter)}</Txt>
      {next ? (
        <Button label={`Chapitre ${next.number}`} icon="arrow-forward" iconRight style={{ alignSelf: 'stretch' }}
          onPress={() => {
            saveChapterProgress(id, 1);
            router.replace(`/read/${next.id}`);
          }} />
      ) : (
        <Txt v="body">Tu es à jour. Le prochain chapitre arrive bientôt.</Txt>
      )}
      <Button variant="soft" icon="chatbubble-outline" label={`${count} commentaires`} style={{ alignSelf: 'stretch' }} onPress={openComments} />
      {adaptedBy && (
        <Press onPress={() => router.push(`/watch/${adaptedBy.id}`)} style={styles.animeLink}>
          <Ionicons name="tv-outline" size={18} color={C.accentText} />
          <Txt v="label" color={C.accentText} style={{ fontSize: 13 }}>Revoir ce passage en anime · Ép. {adaptedBy.number}</Txt>
        </Press>
      )}
    </View>
  );

  const dlIcon = !download ? 'arrow-down-circle-outline' : download.status === 'done' ? 'checkmark-circle' : download.status === 'error' ? 'alert-circle-outline' : null;
  const dlLabel = !download
    ? 'Télécharger le chapitre'
    : download.status === 'done'
      ? 'Chapitre téléchargé, gérer les téléchargements'
      : download.status === 'error'
        ? 'Échec du téléchargement, réessayer'
        : `Téléchargement ${download.saved}/${download.total}, annuler`;
  const onDownload = () => {
    if (!download || download.status === 'error') downloadChapter(id, series.id);
    else if (download.status === 'done') router.push('/offline');
    else cancelDownload(id);
  };

  const shownProgress = pages.length ? (page + 1) / pages.length : 0;

  return (
    <View style={{ flex: 1, backgroundColor: C.black }}>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.white} />
          <Txt v="small">Chargement des pages…</Txt>
        </View>
      ) : (
        <ZoomLayer key={mode} axis={paged ? 'xy' : 'x'} onTap={() => setBars((b) => !b)} onZoomedChange={setZoomed}>
          <FlatList
            key={mode}
            ref={list}
            data={pages}
            keyExtractor={(u, i) => `${i}-${u}`}
            horizontal={paged}
            pagingEnabled={paged}
            scrollEnabled={!(paged && zoomed)}
            showsHorizontalScrollIndicator={false}
            onScroll={onScroll}
            scrollEventThrottle={64}
            initialNumToRender={paged ? 2 : 3}
            maxToRenderPerBatch={4}
            windowSize={paged ? 5 : 7}
            removeClippedSubviews
            maintainVisibleContentPosition={paged ? undefined : { minIndexForVisible: 0 }}
            getItemLayout={(_, index) =>
              paged
                ? { length: width, offset: width * index, index }
                : { length: heights[index] ?? 0, offset: offsets[index] ?? total, index }
            }
            renderItem={({ item, index }) => (
              <View accessible accessibilityLabel={`Page ${index + 1} sur ${pages.length}`}
                style={paged ? { width, height, justifyContent: 'center' } : { width, height: heights[index] }}>
                <Image
                  source={imageSource(item)}
                  style={paged ? { width, height } : { width, height: heights[index] }}
                  contentFit={paged ? 'contain' : 'cover'}
                  transition={120}
                  cachePolicy="memory-disk"
                  recyclingKey={item}
                  priority={Math.abs(index - page) <= 1 ? 'high' : 'normal'}
                  onLoad={(e) => onImageLoad(item, e.source.width, e.source.height)}
                />
              </View>
            )}
            ListFooterComponent={footer}
          />
        </ZoomLayer>
      )}

      {bars && (
        <>
          <View style={[styles.top, { paddingTop: insets.top + S.sm }]}>
            <Press onPress={() => router.back()} style={styles.round} accessibilityLabel="Retour">
              <Ionicons name="chevron-back" size={20} color={C.text} />
            </Press>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="label" numberOfLines={1}>{chapterLabel(chapter)}</Txt>
              <Txt v="small" numberOfLines={1}>
                {series.title}
                {origin === 'offline' ? ' · hors-ligne' : ''}
              </Txt>
            </View>
            <Press onPress={switchMode} style={styles.round}
              accessibilityLabel={paged ? 'Passer en défilement vertical' : 'Passer en mode page par page'}>
              <Ionicons name={paged ? 'reorder-four-outline' : 'albums-outline'} size={19} color={C.text} />
            </Press>
            {downloadsSupported && (
              <Press onPress={onDownload} style={styles.round} accessibilityLabel={dlLabel}>
                {dlIcon ? (
                  <Ionicons name={dlIcon} size={21} color={download?.status === 'done' ? C.accentText : C.text} />
                ) : (
                  <Txt v="caption" color={C.accentText} style={{ fontSize: 10 }}>
                    {download && download.total ? `${Math.round((download.saved / download.total) * 100)}%` : '…'}
                  </Txt>
                )}
              </Press>
            )}
          </View>

          {isContinuation && !toastHidden && (
            <Pressable onPress={() => setToastHidden(true)} style={[styles.toast, { top: insets.top + 72 }]}
              accessibilityLabel="Masquer le message">
              <Txt v="small" color={C.white} style={{ fontSize: 12 }}>
                Suite directe de l’anime (ép. {series.anime!.episodes.length})
              </Txt>
              <Ionicons name="close" size={14} color={C.white} />
            </Pressable>
          )}

          <View style={[styles.bottom, { paddingBottom: insets.bottom + S.md }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Txt v="small" color={C.accentText} style={{ minWidth: 52 }}>
                {pages.length ? `${page + 1} / ${pages.length}` : '–'}
              </Txt>
              <View style={{ flex: 1 }}><Progress value={shownProgress} color={C.accent} height={4} /></View>
              {paged && (
                <View style={{ flexDirection: 'row', gap: S.xs }}>
                  <Press onPress={() => goTo(page - 1)} style={styles.small} accessibilityLabel="Page précédente">
                    <Ionicons name="chevron-back" size={16} color={C.text} />
                  </Press>
                  <Press onPress={() => goTo(page + 1)} style={styles.small} accessibilityLabel="Page suivante">
                    <Ionicons name="chevron-forward" size={16} color={C.text} />
                  </Press>
                </View>
              )}
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Button small variant="soft" label={prev ? `Ch. ${prev.number}` : 'Début'} icon="chevron-back"
                onPress={() => prev && router.replace(`/read/${prev.id}`)} />
              <Button small variant="soft" icon="chatbubble-outline" label={`${count}`} onPress={openComments} />
              {next ? (
                <Button small label={`Ch. ${next.number}`} icon="chevron-forward" iconRight onPress={() => router.replace(`/read/${next.id}`)} />
              ) : (
                <View style={{ width: 80 }} />
              )}
            </View>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: S.sm },
  top: {
    position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', alignItems: 'center', gap: S.sm,
    paddingHorizontal: S.lg, paddingBottom: S.md, backgroundColor: 'rgba(10,10,15,0.94)',
  },
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center' },
  small: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center' },
  toast: {
    position: 'absolute', left: S.lg, flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: R.pill, backgroundColor: C.accent,
  },
  bottom: {
    position: 'absolute', left: 0, right: 0, bottom: 0, gap: 14, paddingTop: 14, paddingHorizontal: S.lg,
    borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: 'rgba(10,10,15,0.96)',
  },
  footer: { backgroundColor: C.bg, padding: S.xl, gap: S.lg, alignItems: 'flex-start' },
  animeLink: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm, padding: S.md, borderRadius: R.card,
    backgroundColor: C.accentSoft, alignSelf: 'stretch',
  },
});
