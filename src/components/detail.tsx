// Building blocks of the series pages (anime / manhwa): full-bleed key art with scrims and
// parallax, a top bar that turns solid and shows the title once the art has scrolled away,
// an expandable synopsis and the "Épisodes · Commentaires" tabs.
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { Extrapolation, interpolate, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Series } from '@/data/catalog';
import { C, F, S } from '@/theme/tokens';

import { Cover, IconButton, Txt } from './ui';

/** Height of the key art on a series page. */
export const useBackdropHeight = () => {
  const { width } = useWindowDimensions();
  return Math.min(560, Math.round(width * 1.12));
};

/**
 * Key art: drifts at half speed while scrolling (depth) and stretches on pull-down (overscroll).
 * `children` sit on the bottom scrim (title, metadata).
 */
export function DetailBackdrop({
  series,
  headers,
  scrollY,
  children,
}: {
  series: Series;
  headers?: Record<string, string>;
  scrollY: SharedValue<number>;
  children?: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const h = useBackdropHeight();
  const art = useAnimatedStyle(() => {
    const y = scrollY.get();
    return {
      transform: [
        { translateY: y < 0 ? y / 2 : y * 0.45 },
        { scale: y < 0 ? 1 - y / h : 1 },
      ],
    };
  });
  return (
    // Clipped below (the drifting art never shows under the content), open above (overscroll stretch).
    <View style={{ height: h }}>
      <View style={[StyleSheet.absoluteFill, { overflow: 'hidden', top: -h }]} pointerEvents="none">
        <Animated.View style={[{ position: 'absolute', left: 0, right: 0, top: h, height: h }, art]}>
          <Cover palette={series.palette} image={series.image} imageHeaders={headers} width={width} height={h} radius={0} outline={false} />
        </Animated.View>
      </View>
      <LinearGradient pointerEvents="none" colors={['rgba(5,7,13,0.75)', 'rgba(5,7,13,0)']} style={styles.topScrim} />
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(5,7,13,0)', 'rgba(5,7,13,0.6)', 'rgba(5,7,13,0.94)', C.bg]}
        locations={[0, 0.4, 0.78, 1]}
        style={styles.bottomScrim}
      />
      <View style={styles.copy}>{children}</View>
    </View>
  );
}

/** Back button over the art; once scrolled past it, a solid bar with the series title. */
export function DetailNav({ title, scrollY, right }: { title: string; scrollY: SharedValue<number>; right?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const h = useBackdropHeight();
  const bar = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.get(), [h - 200, h - 120], [0, 1], Extrapolation.CLAMP),
  }));
  const label = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.get(), [h - 140, h - 90], [0, 1], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(scrollY.get(), [h - 140, h - 90], [6, 0], Extrapolation.CLAMP) }],
  }));
  return (
    <View style={[styles.nav, { paddingTop: insets.top + 4 }]} pointerEvents="box-none">
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.navBg, bar]} />
      <IconButton icon="chevron-back" label="Retour" size={40} onPress={() => router.back()} />
      <Animated.View style={[{ flex: 1 }, label]} pointerEvents="none">
        <Txt v="headline" numberOfLines={1} style={{ textAlign: 'center' }}>{title}</Txt>
      </Animated.View>
      {right ?? <View style={{ width: 40 }} />}
    </View>
  );
}

/** Synopsis clamped to 3 lines, "Plus" expands it. */
export function Synopsis({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  return (
    <Pressable onPress={() => long && setOpen((o) => !o)} disabled={!long} accessibilityRole={long ? 'button' : undefined}
      accessibilityHint={long ? (open ? 'Réduire' : 'Afficher tout le résumé') : undefined}>
      <Txt v="body" color={C.body} numberOfLines={open ? undefined : 3}
        onTextLayout={(e) => { if (!long && e.nativeEvent.lines.length > 3) setLong(true); }}>
        {text}
      </Txt>
      {long && (
        <Text maxFontSizeMultiplier={1.4} style={styles.more}>{open ? 'Moins' : 'Plus'}</Text>
      )}
    </Pressable>
  );
}

/** Underlined tabs ("Épisodes", "Commentaires 12"). */
export function DetailTabs({ tabs }: { tabs: { label: string; active?: boolean; onPress?: () => void; count?: number }[] }) {
  return (
    <View style={styles.tabs} accessibilityRole="tablist">
      {tabs.map((t) => (
        <Pressable key={t.label} onPress={t.onPress} accessibilityRole="tab" accessibilityState={{ selected: !!t.active }}
          style={({ pressed }) => [styles.tab, pressed && !t.active && { opacity: 0.6 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Txt v="headline" color={t.active ? C.text : C.text2} style={!t.active && F.medium}>{t.label}</Txt>
            {t.count != null && t.count > 0 && (
              <View style={styles.count}><Text style={styles.countText}>{t.count}</Text></View>
            )}
          </View>
          <View style={[styles.tabBar, t.active && { backgroundColor: C.accentText }]} />
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  topScrim: { position: 'absolute', left: 0, right: 0, top: 0, height: 160 },
  bottomScrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '60%' },
  copy: { position: 'absolute', left: S.lg, right: S.lg, bottom: S.sm, gap: S.sm },
  nav: {
    position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', alignItems: 'center', gap: S.md,
    paddingHorizontal: S.lg, paddingBottom: S.sm,
  },
  navBg: { backgroundColor: 'rgba(8,11,19,0.96)', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.hairline },
  more: { color: C.text, fontSize: 14, ...F.semibold, marginTop: 4 },
  tabs: { flexDirection: 'row', gap: S.xl, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.hairline },
  tab: { paddingTop: 4, gap: 10, minHeight: 44, justifyContent: 'flex-end' },
  tabBar: { height: 3, borderTopLeftRadius: 2, borderTopRightRadius: 2, backgroundColor: 'transparent' },
  count: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center' },
  countText: { color: C.text2, fontSize: 11, ...F.bold, fontVariant: ['tabular-nums'] },
});
