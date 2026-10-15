// Web build of the home hero (same API as ./hero.tsx).
//
// The native carousel is a paging ScrollView whose first page is a clone, opened at
// `contentOffset`; react-native-web ignores `contentOffset`, so the art slid 40 % off its slide
// and left a black band (the phone "hero offset" bug). The web has no paging swipe to keep in sync
// anyway: slides are stacked and cross-fade.
//
// · From 768 px of content: a wide banner, copy on the left (Stremio / streaming-site layout),
//   arrows on hover, ←/→ when focused, dots you can click.
// · Below: the phone layout of the native hero (poster art, centered copy), with swipe.
// · Rotates every 7 s; pauses while hovered, focused or touched; never with Reduce Motion.
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { traceTap } from '@/addons/timing';
import { seriesHref } from '@/data/anilist-api';
import { continuationChapter } from '@/data/bridge';
import type { Series } from '@/data/catalog';
import { franchiseTarget, resolvePrequels, useFranchiseTarget } from '@/data/franchise';
import { toggleMyList, useStore } from '@/store/store';
import { C, F, R, S, SHADOW } from '@/theme/tokens';

import { Skeleton } from './skeleton';
import { LineSkeleton } from './skeletons';
import { ActionTile, Button, Cover, MetaLine, Txt } from './ui';

const AUTO_MS = 7000;
const FADE_MS = 650;
const WIDE = 768;
const fade = Easing.bezier(0.65, 0, 0.35, 1);

const phoneHeight = (width: number) => Math.min(760, Math.max(520, Math.round(width * 1.42)));
const wideHeight = (width: number) => Math.min(560, Math.max(380, Math.round(width * 0.4)));

type WebState = { hovered?: boolean; focused?: boolean; pressed: boolean };

export function HeroCarousel({ items }: { items: Series[] }) {
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const focusedScreen = useIsFocused();
  const reduce = useReducedMotion();
  const n = items.length;
  const [active, setActive] = useState(0);
  const [hold, setHold] = useState(false);
  const touchX = useRef<number | null>(null);

  const go = useCallback((i: number) => setActive(((i % n) + n) % n), [n]);
  const auto = focusedScreen && !reduce && !hold && n > 1;

  useEffect(() => {
    if (!auto) return;
    const timer = setTimeout(() => go(active + 1), AUTO_MS);
    return () => clearTimeout(timer);
  }, [auto, active, go]);

  if (!n) return null;
  const height = wide ? wideHeight(width) : phoneHeight(width);

  const onKey = (e: { nativeEvent: { key: string }; preventDefault?: () => void }) => {
    if (e.nativeEvent.key === 'ArrowRight') go(active + 1);
    else if (e.nativeEvent.key === 'ArrowLeft') go(active - 1);
  };
  const onTouchStart = (e: GestureResponderEvent) => {
    touchX.current = e.nativeEvent.pageX;
    setHold(true);
  };
  const onTouchEnd = (e: GestureResponderEvent) => {
    const start = touchX.current;
    touchX.current = null;
    setHold(false);
    if (start === null) return;
    const dx = e.nativeEvent.pageX - start;
    if (Math.abs(dx) > 48) go(active + (dx < 0 ? 1 : -1));
  };

  return (
    <View
      style={{ height }}
      role="region"
      aria-roledescription="carrousel"
      aria-label="À la une"
      {...({ onMouseEnter: () => setHold(true), onMouseLeave: () => setHold(false), onKeyDown: onKey } as object)}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={() => setHold(false)}>
      {items.map((s, i) => (
        <Slide key={s.id} series={s} active={i === active} wide={wide} width={width} height={height} reduce={reduce} />
      ))}
      {wide && n > 1 && (
        <>
          <Arrow side="left" onPress={() => go(active - 1)} visible={hold} />
          <Arrow side="right" onPress={() => go(active + 1)} visible={hold} />
        </>
      )}
      {n > 1 && (
        <View style={[styles.dots, wide ? { left: S.xxl + S.lg, bottom: S.xl } : { left: 0, right: 0, justifyContent: 'center', bottom: 14 }]} role="tablist">
          {items.map((s, i) => (
            <Pressable
              key={s.id}
              onPress={() => go(i)}
              role="tab"
              aria-selected={i === active}
              accessibilityLabel={`${s.title}, ${i + 1} sur ${n}`}
              hitSlop={8}
              style={(st) => [styles.dotHit, (st as WebState).focused && styles.focus]}>
              <View style={[styles.dot, i === active && styles.dotOn]} />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

/** The hero before the catalog is known: same height and layout (wide banner or phone poster). */
export function HeroSkeleton() {
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const height = wide ? wideHeight(width) : phoneHeight(width);
  if (!wide) {
    return (
      <Skeleton height={height} radius={0} tint={C.surface}>
        <View style={[styles.copy, { gap: 14 }]} accessibilityLabel="Chargement" accessibilityRole="progressbar">
          <LineSkeleton width="70%" height={34} tint={C.elevated} />
          <LineSkeleton width="52%" height={13} tint={C.elevated} />
          <View style={styles.actions}>
            <Skeleton width={64} height={50} radius={12} tint={C.elevated} />
            <Skeleton height={50} radius={12} tint={C.elevated} style={{ flex: 1 }} />
            <Skeleton width={64} height={50} radius={12} tint={C.elevated} />
          </View>
        </View>
      </Skeleton>
    );
  }
  const poster = Math.min(height - 64, 380);
  return (
    <View style={{ height }} accessibilityLabel="Chargement" accessibilityRole="progressbar">
      <Skeleton height={height} radius={0} tint={C.surface} style={StyleSheet.absoluteFill} />
      <View style={styles.wideCopy}>
        <LineSkeleton width={90} height={11} tint={C.elevated} />
        <LineSkeleton width="80%" height={44} tint={C.elevated} />
        <LineSkeleton width="45%" height={13} tint={C.elevated} />
        <View style={{ gap: 8, maxWidth: 560 }}>
          <LineSkeleton width="100%" height={13} tint={C.elevated} />
          <LineSkeleton width="92%" height={13} tint={C.elevated} />
          <LineSkeleton width="60%" height={13} tint={C.elevated} />
        </View>
        <View style={styles.wideActions}>
          <Skeleton width={220} height={56} radius={12} tint={C.elevated} />
          <Skeleton width={150} height={56} radius={12} tint={C.elevated} />
          <Skeleton width={110} height={56} radius={12} tint={C.elevated} />
        </View>
      </View>
      <Skeleton width={Math.round(poster / 1.42)} height={poster} radius={R.poster} tint={C.elevated} style={styles.widePoster} />
    </View>
  );
}

function Arrow({ side, onPress, visible }: { side: 'left' | 'right'; onPress: () => void; visible: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={side === 'left' ? 'Précédent' : 'Suivant'}
      style={(st) => {
        const s = st as WebState;
        return [styles.arrow, side === 'left' ? { left: S.md } : { right: S.md }, { opacity: visible || s.focused ? 1 : 0 }, s.hovered && styles.arrowHover, s.focused && styles.focus];
      }}>
      <Ionicons name={side === 'left' ? 'chevron-back' : 'chevron-forward'} size={22} color={C.text} />
    </Pressable>
  );
}

function Slide({ series, active, wide, width, height, reduce }: { series: Series; active: boolean; wide: boolean; width: number; height: number; reduce: boolean }) {
  const o = useSharedValue(active ? 1 : 0);
  useEffect(() => {
    o.set(withTiming(active ? 1 : 0, { duration: reduce ? 0 : FADE_MS, easing: fade }));
  }, [active, o, reduce]);
  const style = useAnimatedStyle(() => ({ opacity: o.get(), transform: [{ scale: 1.03 - 0.03 * o.get() }] }));
  // Hidden slides stay mounted for the cross-fade: keep their buttons out of Tab and screen readers.
  const root = useRef<View>(null);
  useEffect(() => {
    const el = root.current as unknown as HTMLElement | null;
    if (el) el.inert = !active;
  }, [active]);

  const eps = series.anime?.episodes ?? [];
  const { target, seasonNumber } = useFranchiseTarget(series, active);
  const nextCh = series.anime ? continuationChapter(series) : series.manhwa?.chapters[0];
  const inList = useStore((s) => s.myList.includes(series.id));
  const opening = useRef(false);

  const open = () => router.push(seriesHref(series));
  const play = async () => {
    if (opening.current) return;
    opening.current = true;
    try {
      let t = target;
      if (!t) {
        await Promise.race([resolvePrequels(series), new Promise((r) => setTimeout(r, 4000))]);
        t = franchiseTarget(series);
      }
      if (t) {
        traceTap(t.episode.id);
        router.push(`/watch/${t.episode.id}`);
      }
    } finally {
      opening.current = false;
    }
  };

  const status = series.anime
    ? series.status === 'completed'
      ? seasonNumber && seasonNumber > 1 ? `Saison ${seasonNumber} terminée` : 'Saison terminée'
      : `${seasonNumber ? `Saison ${seasonNumber} · ` : ''}${eps.length} épisodes`
    : `${series.manhwa!.chapters.length} chapitres`;
  const meta = [series.anime ? 'Anime' : 'Manhwa', ...status.split(' · '), ...series.genres.slice(0, wide ? 3 : 2)];

  const primary =
    eps.length > 0 ? (
      <Button icon="play" label={target?.label ?? 'Lecture'} onPress={play} style={wide ? { minWidth: 220 } : { flex: 1 }} large={wide} />
    ) : nextCh ? (
      <Button icon="book" label={`Lire · Ch. ${nextCh.number}`} onPress={() => router.push(`/read/${nextCh.id}`)} style={wide ? { minWidth: 200 } : { flex: 1 }} large={wide} />
    ) : null;

  return (
    <Animated.View
      ref={root}
      style={[StyleSheet.absoluteFill, style, { zIndex: active ? 1 : 0 }]}
      pointerEvents={active ? 'auto' : 'none'}>
      {wide ? (
        <View style={StyleSheet.absoluteFill}>
          {/* Banner (poster when there is none): tinted skeleton while it loads, like every cover. */}
          <Cover palette={series.palette} image={series.banner ?? series.image} width={series.banner ? undefined : width} height={height} radius={0} outline={false} priority={active ? 'high' : 'low'} />
          <LinearGradient pointerEvents="none" colors={['rgba(5,7,13,0.96)', 'rgba(5,7,13,0.75)', 'rgba(5,7,13,0.15)']} locations={[0, 0.42, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
          <LinearGradient pointerEvents="none" colors={['rgba(5,7,13,0)', C.bg]} locations={[0.55, 1]} style={StyleSheet.absoluteFill} />
          <View style={styles.wideCopy}>
            <Txt v="caption" color={C.accentText}>À la une</Txt>
            <Txt v="display" numberOfLines={2} style={styles.wideTitle} onPress={open} accessibilityRole="link">{series.title}</Txt>
            <MetaLine items={meta} color={C.body} />
            {!!series.synopsis && (
              <Txt v="body" color={C.body} numberOfLines={3} style={{ maxWidth: 560, lineHeight: 22 }}>{series.synopsis.replace(/<[^>]+>/g, '')}</Txt>
            )}
            <View style={styles.wideActions}>
              {primary}
              <Button variant="glass" icon={inList ? 'checkmark' : 'add'} label={inList ? 'Dans ma liste' : 'Ma liste'} onPress={() => toggleMyList(series.id)} large />
              <Button variant="glass" icon="information-circle-outline" label="Infos" onPress={open} large />
            </View>
          </View>
          {series.image && (
            <Pressable onPress={open} accessibilityRole="link" accessibilityLabel={`${series.title}, fiche`} style={[styles.widePoster, { height: Math.min(height - 64, 380) }]} tabIndex={-1}>
              <Cover palette={series.palette} image={series.image} height={Math.min(height - 64, 380)} width={Math.round(Math.min(height - 64, 380) / 1.42)} style={{ boxShadow: SHADOW.float }} />
            </Pressable>
          )}
        </View>
      ) : (
        <Pressable onPress={open} accessible={false} style={StyleSheet.absoluteFill}>
          <Cover palette={series.palette} image={series.image} width={width} height={height} radius={0} outline={false} priority={active ? 'high' : 'low'} />
          <LinearGradient pointerEvents="none" colors={['rgba(5,7,13,0.85)', 'rgba(5,7,13,0.35)', 'rgba(5,7,13,0)']} locations={[0, 0.45, 1]} style={styles.topScrim} />
          <LinearGradient pointerEvents="none" colors={['rgba(5,7,13,0)', 'rgba(5,7,13,0.55)', 'rgba(5,7,13,0.92)', C.bg]} locations={[0, 0.35, 0.72, 1]} style={styles.bottomScrim} />
          <View style={styles.copy}>
            <Txt v="display" numberOfLines={2} style={styles.title} onPress={open} accessibilityRole="link">{series.title}</Txt>
            <MetaLine center color={C.body} items={meta} />
            <View style={styles.actions}>
              <ActionTile icon={inList ? 'checkmark' : 'add'} label="Ma liste" active={inList} onPress={() => toggleMyList(series.id)}
                accessibilityLabel={inList ? 'Retirer de ma liste' : 'Ajouter à ma liste'} />
              {primary ?? <View style={{ flex: 1 }} />}
              {eps.length > 0 && nextCh ? (
                <ActionTile icon="book-outline" label={`Ch. ${nextCh.number}`} onPress={() => router.push(`/read/${nextCh.id}`)} accessibilityLabel={`Lire le manhwa, chapitre ${nextCh.number}`} />
              ) : (
                <ActionTile icon="information-circle-outline" label="Infos" onPress={open} accessibilityLabel="Plus d’infos" />
              )}
            </View>
          </View>
        </Pressable>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  topScrim: { position: 'absolute', left: 0, right: 0, top: 0, height: 200 },
  bottomScrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '62%' },
  copy: { position: 'absolute', left: S.lg, right: S.lg, bottom: 40, gap: 12, alignItems: 'center' },
  title: { fontSize: 38, lineHeight: 42, letterSpacing: -1.2, textAlign: 'center', ...F.black, textShadowColor: 'rgba(0,0,0,0.45)', textShadowRadius: 18 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: S.md, alignSelf: 'stretch', marginTop: 6 },
  wideCopy: { position: 'absolute', left: S.xxl + S.lg, bottom: S.xxl + S.xl, right: '38%', gap: S.md },
  wideTitle: { fontSize: 48, lineHeight: 52, letterSpacing: -1.5, ...F.black, textShadowColor: 'rgba(0,0,0,0.4)', textShadowRadius: 20 },
  wideActions: { flexDirection: 'row', alignItems: 'center', gap: S.sm, marginTop: S.sm, flexWrap: 'wrap' },
  widePoster: { position: 'absolute', right: S.xxl + S.lg, top: S.xxl, borderRadius: R.card },
  dots: { position: 'absolute', flexDirection: 'row', gap: 2, zIndex: 2 },
  dotHit: { padding: 6, borderRadius: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.28)' },
  dotOn: { width: 24, backgroundColor: C.white },
  arrow: {
    position: 'absolute', top: '50%', marginTop: -24, width: 48, height: 48, borderRadius: 24, zIndex: 2,
    alignItems: 'center', justifyContent: 'center', backgroundColor: C.glass, borderWidth: 1, borderColor: C.glassLine,
    transitionProperty: 'opacity, background-color', transitionDuration: '180ms',
  } as object,
  arrowHover: { backgroundColor: 'rgba(30,38,58,0.9)' },
  focus: { outlineColor: C.accentText, outlineWidth: 2, outlineStyle: 'solid', outlineOffset: 2 } as object,
});
