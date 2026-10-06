// The manhwa reader. Immersive by default (no bars: a tap shows the overlay), one continuous list
// across chapters (the next chapter is appended as the end nears, the previous one prepended when
// scrolling back past the top), vertical or paged (RTL / LTR / vertical pages), settings per
// Global / Source / Titre scope. Progress is saved per chapter as the viewport crosses them.
import Ionicons from '@expo/vector-icons/Ionicons';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { router, Stack } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { autoDownloadAfter, downloadChapter, downloadsSupported, pauseDownload, resumeDownload, useDownload } from '@/components/reader/downloads';
import { Button, Press, Txt } from '@/components/ui';
import { animeEndChapter } from '@/data/bridge';
import { chapterLabel, getChapter, PAGE_ASPECT } from '@/data/catalog';
import { isDemo } from '@/demo/flags';
import { getInstalled } from '@/manga-ext/registry';
import { useSourceLink } from '@/manga-ext/link';
import { useThread } from '@/store/derived';
import { getState, saveChapterProgress } from '@/store/store';
import { C, S } from '@/theme/tokens';

import { buildFeed, indexOfPage, layoutFeed, locate, type FeedItem, type Location } from './feed';
import { DIVIDER_H, DividerView, PageView } from './FeedItems';
import { langFlag } from './lang';
import { prefetchPages } from './pages';
import { getAspects, getPosition, saveAspects, savePosition } from './position';
import { ReaderOverlay } from './ReaderOverlay';
import { ReaderSettingsSheet } from './ReaderSettingsSheet';
import { setActiveSetting, useReaderSettings } from './settings-store';
import { neighbours, useChapterFeed } from './useChapterFeed';
import { ZoomLayer } from './ZoomLayer';

const PREFETCH_AHEAD = 5;
const KEEP_AWAKE_TAG = 'huwa-reader';
const BACKGROUNDS = { theme: C.bg, black: '#000000', gray: '#2A2D34', white: '#FFFFFF' } as const;

type Loc = { chapterId: string; page: number; offset: number };

/** Where to open a chapter: its exact saved position, else its coarse progress. */
function startLocation(chapterId: string): Loc {
  const pos = getPosition(chapterId);
  if (pos) return { chapterId, page: pos.page, offset: pos.offset };
  const saved = getState().chapters[chapterId];
  const count = getChapter(chapterId)?.chapter.pageCount ?? 0;
  if (saved && !saved.done && saved.ratio > 0.05 && count > 1) return { chapterId, page: Math.floor(saved.ratio * (count - 1)), offset: 0 };
  return { chapterId, page: 0, offset: 0 };
}

function persist(at: Location | Loc | null, ratio?: number) {
  if (!at) return;
  savePosition(at.chapterId, { page: at.page, offset: at.offset });
  if (ratio !== undefined) saveChapterProgress(at.chapterId, ratio);
}

export function ChapterReader({ startId, onRestart }: { startId: string; onRestart: (chapterId: string) => void }) {
  const insets = useSafeAreaInsets();
  const { width: W, height: H } = useWindowDimensions();
  const { series } = getChapter(startId)!;
  const link = useSourceLink(series.id);
  const keys = { source: link?.key, title: series.id };
  const settings = useReaderSettings(keys);
  const paged = settings.type === 'paged';
  const axis: 'x' | 'y' = paged && settings.direction !== 'webtoon' ? 'x' : 'y';
  const rtl = paged && settings.direction === 'rtl';
  const vp = axis === 'x' ? W : H;

  const [loc, setLoc] = useState<Loc>(() => startLocation(startId));
  const feed = useChapterFeed(startId);
  const [aspects, setAspects] = useState<Record<string, number>>({});
  const [overlay, setOverlay] = useState(true);
  const [sheet, setSheet] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [toastHidden, setToastHidden] = useState(false);

  const list = useRef<FlatList<FeedItem>>(null);
  const lastLoc = useRef<Location | null>(null);
  const scrollPos = useRef(0);
  const lastSave = useRef(0);
  const placed = useRef(false);
  const touched = useRef(false);
  const pendingAspects = useRef<Record<string, number>>({});
  const aspectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const current = getChapter(loc.chapterId) ?? getChapter(startId)!;
  const chapter = current.chapter;
  const segment = feed.segments.find((s) => s.chapterId === loc.chapterId) ?? feed.segments[0];
  const { prev, next } = neighbours(chapter.id);

  // ---------- layout ----------
  const landscape = W > H;
  const pageW = Math.round(W * (landscape ? settings.widthLandscape : settings.widthPortrait));
  const gap = settings.separate ? 12 : 0;
  const items = useMemo(() => buildFeed(feed.segments, feed.prevOf?.id, feed.nextOf?.id), [feed.segments, feed.prevOf, feed.nextOf]);
  const seeds = useMemo(() => {
    const out: Record<string, number[] | undefined> = {};
    for (const s of feed.segments) {
      const a = getAspects(s.chapterId);
      out[s.chapterId] = a?.length === s.pages.length ? a : undefined;
    }
    return out;
  }, [feed.segments]);
  const aspectOf = (it: Extract<FeedItem, { kind: 'page' }>) => {
    const known = aspects[it.uri] ?? seeds[it.chapterId]?.[it.index];
    return known && known > 0 ? known : PAGE_ASPECT;
  };
  const layout = useMemo(
    () =>
      layoutFeed(items, (it) => {
        if (paged) return vp;
        if (it.kind === 'divider') return DIVIDER_H;
        return Math.round(pageW / aspectOf(it)) + gap;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, aspects, seeds, paged, vp, pageW, gap],
  );

  // ---------- system bars, orientation, screen ----------
  const immersive = !overlay && !sheet;
  useEffect(() => {
    const O = ScreenOrientation.OrientationLock;
    if (!settings.orientationLock) {
      ScreenOrientation.lockAsync(O.DEFAULT).catch(() => {});
      return;
    }
    ScreenOrientation.getOrientationAsync()
      .then((o) => {
        const Or = ScreenOrientation.Orientation;
        const lock = o === Or.LANDSCAPE_LEFT ? O.LANDSCAPE_LEFT : o === Or.LANDSCAPE_RIGHT ? O.LANDSCAPE_RIGHT : O.PORTRAIT_UP;
        return ScreenOrientation.lockAsync(lock);
      })
      .catch(() => {});
  }, [settings.orientationLock]);
  useEffect(() => () => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  }, []);
  useEffect(() => {
    if (!settings.keepAwake) return;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [settings.keepAwake]);

  // The overlay shows on arrival (what is where), then gets out of the way.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!touched.current) setOverlay(false);
    }, 2600);
    return () => clearTimeout(t);
  }, []);

  // ---------- position ----------
  const startIndex = (() => {
    const i = indexOfPage(items, loc.chapterId, Math.min(loc.page, (segment?.pages.length ?? 1) - 1));
    return i >= 0 ? i : Math.max(0, items.findIndex((it) => it.kind === 'page'));
  })();

  /** First layout of the list: exact offset inside the resumed page. */
  const place = () => {
    if (placed.current) return;
    placed.current = true;
    const i = startIndex;
    const off = paged ? 0 : (layout.offsets[i] ?? 0) + loc.offset * Math.max(0, (layout.sizes[i] ?? 0) - gap);
    if (off > 0) requestAnimationFrame(() => list.current?.scrollToOffset({ offset: off, animated: false }));
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset } = e.nativeEvent;
    const y = axis === 'x' ? contentOffset.x : contentOffset.y;
    const goingBack = y < scrollPos.current;
    scrollPos.current = y;
    const at = locate(items, layout, y, vp, paged);
    if (!at) return;
    lastLoc.current = at;
    if (at.chapterId !== loc.chapterId || at.page !== loc.page) setLoc({ chapterId: at.chapterId, page: at.page, offset: at.offset });
    if (Date.now() - lastSave.current > 600) {
      lastSave.current = Date.now();
      persist(at, at.ratio);
    }
    if (!placed.current) return;
    // Window edges: append the next chapter well ahead, prepend the previous one when going back.
    if (layout.total - (y + vp) < vp * (paged ? 3 : 6)) feed.loadNext();
    if (goingBack && touched.current && y < vp * 1.5 && items[0]?.kind === 'divider') feed.loadPrev();
  };

  // Crossing into another chapter: the one left behind (forward) is read; far chapters are dropped.
  const prevChapter = useRef(loc.chapterId);
  useEffect(() => {
    const from = prevChapter.current;
    if (from === loc.chapterId) return;
    prevChapter.current = loc.chapterId;
    const list = getChapter(loc.chapterId)?.series.manhwa?.chapters ?? [];
    const forward = list.findIndex((c) => c.id === loc.chapterId) > list.findIndex((c) => c.id === from);
    if (forward) saveChapterProgress(from, 1);
    feed.prune(loc.chapterId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.chapterId]);

  // Short window (short chapter, or pages just loaded): fetch the next chapter right away.
  useEffect(() => {
    if (feed.segments.length && layout.total - (scrollPos.current + vp) < vp * (paged ? 3 : 6)) feed.loadNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.segments.length, layout.total]);

  // Warm the next pages of the current chapter.
  useEffect(() => {
    if (!segment) return;
    const at = segment.chapterId === loc.chapterId ? loc.page : 0;
    prefetchPages(segment.pages.slice(at + 1, at + 1 + PREFETCH_AHEAD), segment.headers);
  }, [segment, loc.page, loc.chapterId]);

  // The chapter appended after the current one: its first pages are warmed right away.
  const tail = feed.segments[feed.segments.length - 1];
  useEffect(() => {
    if (tail && tail.chapterId !== loc.chapterId) prefetchPages(tail.pages.slice(0, 3), tail.headers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tail]);

  // Opt-in: download the following chapters in the background (Wi-Fi only) — real pages only.
  const origin = segment?.origin;
  useEffect(() => {
    if (origin === 'addon' || (isDemo && origin === 'placeholder')) autoDownloadAfter(loc.chapterId);
  }, [loc.chapterId, origin]);

  // Sources registered after the placeholder pages were shown: start again with the real pages.
  useEffect(() => {
    if (feed.stale) onRestart(lastLoc.current?.chapterId ?? startId);
  }, [feed.stale, onRestart, startId]);

  // Leaving the reader: keep the very last position.
  useEffect(() => () => persist(lastLoc.current, lastLoc.current?.ratio), []);

  // ---------- measured page ratios (batched, remembered for the next visit) ----------
  const onAspect = (uri: string, r: number) => {
    const known = aspects[uri] ?? pendingAspects.current[uri];
    if (known !== undefined && Math.abs(known - r) < 0.01) return;
    pendingAspects.current[uri] = r;
    if (aspectTimer.current) return;
    aspectTimer.current = setTimeout(() => {
      aspectTimer.current = undefined;
      const batch = pendingAspects.current;
      pendingAspects.current = {};
      setAspects((a) => ({ ...a, ...batch }));
    }, 120);
  };
  useEffect(() => () => clearTimeout(aspectTimer.current), []);
  useEffect(() => {
    if (!Object.keys(aspects).length) return;
    const t = setTimeout(() => {
      for (const s of feed.segments) {
        const prevA = getAspects(s.chapterId);
        if (!s.pages.some((u) => aspects[u])) continue;
        saveAspects(s.chapterId, s.pages.map((u, i) => aspects[u] ?? (prevA?.length === s.pages.length ? prevA[i] : 0) ?? 0));
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [aspects, feed.segments]);

  // ---------- navigation ----------
  const scrollToItem = (i: number, animated = true) => {
    if (i < 0) return;
    list.current?.scrollToOffset({ offset: layout.offsets[i] ?? 0, animated });
  };
  const goChapter = (id?: string) => {
    if (!id) return;
    const i = indexOfPage(items, id, 0);
    if (i >= 0) return scrollToItem(i, false);
    persist(lastLoc.current, lastLoc.current?.ratio);
    onRestart(id);
  };
  const step = (dir: 1 | -1) => {
    if (paged) scrollToItem(Math.max(0, Math.min(items.length - 1, Math.round(scrollPos.current / vp) + dir)));
    else list.current?.scrollToOffset({ offset: Math.max(0, scrollPos.current + dir * vp * 0.8), animated: true });
  };
  const onTap = (x: number) => {
    touched.current = true;
    if (settings.tapToScroll && !zoomed) {
      const zone = x < W * 0.3 ? 'left' : x > W * 0.7 ? 'right' : 'center';
      if (zone !== 'center') {
        const forward = paged && axis === 'x' ? (rtl ? zone === 'left' : zone === 'right') : settings.hand === 'right' ? zone === 'right' : zone === 'left';
        step(forward ? 1 : -1);
        if (overlay && settings.autoHide) setOverlay(false);
        return;
      }
    }
    setOverlay((o) => !o);
  };

  // ---------- overlay data ----------
  const download = useDownload(chapter.id);
  const comments = useThread(`ch:${chapter.id}`).length;
  const sourceName = (link && getInstalled(link.key)?.name) ?? segment?.sourceName ?? 'Extensions';
  const isContinuation = !!series.anime && chapter.number === animeEndChapter(series) + 1;
  const flag = link ? langFlag(link.lang) : undefined;
  const count = segment?.chapterId === loc.chapterId ? segment.pages.length : (segment?.pages.length ?? 0);

  const dl = downloadsSupported
    ? {
        icon: !download
          ? ('arrow-down-circle-outline' as const)
          : download.status === 'done'
            ? ('checkmark-circle' as const)
            : download.status === 'error'
              ? ('alert-circle-outline' as const)
              : download.status === 'paused'
                ? ('pause-circle-outline' as const)
                : null,
        label: !download
          ? 'Télécharger le chapitre'
          : download.status === 'done'
            ? 'Chapitre téléchargé, gérer les téléchargements'
            : download.status === 'error'
              ? 'Échec du téléchargement, réessayer'
              : download.status === 'paused'
                ? 'Téléchargement en pause, reprendre'
                : `Téléchargement ${download.saved}/${download.total}, mettre en pause`,
        progress: download && download.total ? `${Math.round((download.saved / download.total) * 100)}%` : '…',
        done: download?.status === 'done',
        onPress: () => {
          if (!download) downloadChapter(chapter.id, series.id);
          else if (download.status === 'error' || download.status === 'paused') resumeDownload(chapter.id);
          else if (download.status === 'done') router.push('/offline');
          else pauseDownload(chapter.id);
        },
      }
    : undefined;

  const bg = BACKGROUNDS[settings.background];
  const light = settings.background === 'white';
  const bars = (
    <>
      <StatusBar hidden={settings.hideBars && immersive} animated style="light" />
      <Stack.Screen options={{ autoHideHomeIndicator: settings.hideBars && immersive }} />
    </>
  );

  // ---------- states before the first chapter is in ----------
  const anchorLoad = feed.loads[startId];
  if (!feed.segments.length) {
    return (
      <View style={[styles.center, { backgroundColor: bg }]}>
        {bars}
        <View style={[styles.closeAlone, { top: insets.top + S.sm }]}>
          <Press onPress={() => router.back()} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel="Fermer le lecteur">
            <Ionicons name="close" size={20} color={C.text} />
          </Press>
        </View>
        {anchorLoad?.status === 'error' ? (
          <View style={{ alignItems: 'center', gap: S.sm, paddingHorizontal: S.xl }}>
            <Ionicons name="cloud-offline-outline" size={34} color={C.text2} />
            <Txt v="label" style={{ textAlign: 'center' }}>Pages indisponibles</Txt>
            <Txt v="small" style={{ textAlign: 'center' }}>{anchorLoad.error ?? 'Aucune source ne fournit ce chapitre.'}</Txt>
            <Button small variant="soft" icon="refresh" label="Réessayer" onPress={() => feed.retry(startId)} />
          </View>
        ) : (
          <>
            <ActivityIndicator color={light ? C.bg : C.white} />
            <Txt v="small" color={light ? C.bg : C.text2}>Chargement des pages…</Txt>
          </>
        )}
      </View>
    );
  }

  const renderItem = ({ item }: { item: FeedItem }) => {
    if (item.kind === 'divider') {
      const beforeLoaded = !!item.before && feed.segments.some((s) => s.chapterId === item.before);
      const pending = beforeLoaded ? item.after : item.before;
      return (
        <DividerView before={item.before} after={item.after} beforeLoaded={beforeLoaded} afterLoad={pending ? feed.loads[pending] : undefined}
          boxW={W} boxH={paged ? H : DIVIDER_H} paged={paged} flip={rtl} flag={flag} onRetry={feed.retry} />
      );
    }
    const seg = feed.segments[item.seg];
    if (paged) {
      const a = aspectOf(item);
      const maxW = Math.min(pageW, W);
      const fitW = Math.min(maxW, H * a);
      return (
        <PageView uri={item.uri} headers={seg?.headers} boxW={W} boxH={H} w={fitW} h={fitW / a} number={item.index + 1}
          downsample={settings.downsample} flip={rtl} light={light} onAspect={onAspect} />
      );
    }
    const h = Math.round(pageW / aspectOf(item));
    return (
      <PageView uri={item.uri} headers={seg?.headers} boxW={W} boxH={h + gap} w={pageW} h={h} number={item.index + 1} top
        downsample={settings.downsample} light={light} onAspect={onAspect} />
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      {bars}
      <ZoomLayer key={`${settings.type}-${settings.direction}`} axis={paged ? 'xy' : 'x'} onTap={onTap} onZoomedChange={setZoomed}>
        <FlatList
          key={`${axis}-${paged ? 'p' : 'v'}`}
          ref={list}
          data={items}
          keyExtractor={(it) => it.key}
          renderItem={renderItem}
          extraData={layout}
          horizontal={axis === 'x'}
          pagingEnabled={paged}
          scrollEnabled={!(paged && zoomed)}
          style={rtl ? { transform: [{ scaleX: -1 }] } : undefined}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={32}
          onScrollBeginDrag={() => {
            touched.current = true;
            if (settings.autoHide && overlay) setOverlay(false);
          }}
          onLayout={place}
          initialScrollIndex={startIndex}
          initialNumToRender={paged ? 2 : 3}
          maxToRenderPerBatch={paged ? 2 : 3}
          updateCellsBatchingPeriod={40}
          windowSize={paged ? 5 : 7}
          removeClippedSubviews
          decelerationRate={paged ? 'fast' : 'normal'}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          getItemLayout={(_, index) => ({ length: layout.sizes[index] ?? 0, offset: layout.offsets[index] ?? layout.total, index })}
        />
      </ZoomLayer>

      <ReaderOverlay
        visible={overlay && !sheet}
        insets={insets}
        width={W}
        height={H}
        title={chapterLabel(chapter)}
        subtitle={`${series.title}${segment?.origin === 'offline' ? ' · hors-ligne' : link ? ` · ${sourceName}` : ''}${flag ? ` ${flag}` : ''}`}
        page={Math.min(loc.page, Math.max(0, count - 1))}
        count={count}
        onPick={(p) => scrollToItem(indexOfPage(items, loc.chapterId, p), false)}
        hand={settings.hand}
        onClose={() => router.back()}
        prev={prev?.number}
        next={next?.number}
        onPrev={() => goChapter(prev?.id)}
        onNext={() => goChapter(next?.id)}
        comments={comments}
        onComments={() => router.push({ pathname: '/comments', params: { target: `ch:${chapter.id}`, kind: 'manhwa' } })}
        download={dl}
        locked={settings.orientationLock}
        onToggleLock={() => setActiveSetting(keys, { orientationLock: !settings.orientationLock })}
        onSettings={() => setSheet(true)}
        toast={isContinuation && !toastHidden ? `Suite directe de l’anime (ép. ${series.anime!.episodes.length})` : undefined}
        onDismissToast={() => setToastHidden(true)}
        alwaysPage={settings.pageNumber}
      />

      <ReaderSettingsSheet visible={sheet} onClose={() => setSheet(false)} keys={keys} sourceName={sourceName} seriesTitle={series.title} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: S.sm },
  closeAlone: { position: 'absolute', left: S.lg },
  closeBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: C.elevated },
});
