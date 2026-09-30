import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

import { continuationChapter, resumeEpisode } from '@/data/bridge';
import type { Series } from '@/data/catalog';
import { useStore } from '@/store/store';
import { C, S } from '@/theme/tokens';

import { Button, Chip, Cover, Txt } from './ui';

const HERO_H = 560;

/** Full-bleed paging hero. Art drifts at 40% of the swipe speed (parallax) — purpose: spatial depth. */
export function HeroCarousel({ items }: { items: Series[] }) {
  const { width } = useWindowDimensions();
  const x = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    x.set(e.contentOffset.x);
  });

  return (
    <View style={{ height: HERO_H }}>
      <Animated.FlatList
        data={items}
        keyExtractor={(s) => s.id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        decelerationRate="fast"
        renderItem={({ item, index }) => <Slide series={item} index={index} x={x} width={width} />}
      />
      <View style={styles.dots} pointerEvents="none">
        {items.map((s, i) => (
          <Dot key={s.id} index={i} x={x} width={width} />
        ))}
      </View>
    </View>
  );
}

function Slide({ series, index, x, width }: { series: Series; index: number; x: SharedValue<number>; width: number }) {
  const episodes = useStore((s) => s.episodes);
  const eps = series.anime?.episodes ?? [];
  const resume = resumeEpisode(series, episodes);
  const nextCh = series.anime ? continuationChapter(series) : series.manhwa?.chapters[0];

  const art = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(x.get(), [(index - 1) * width, index * width, (index + 1) * width], [-width * 0.4, 0, width * 0.4], Extrapolation.CLAMP),
      },
      { scale: interpolate(x.get(), [(index - 1) * width, index * width, (index + 1) * width], [1.12, 1, 1.12], Extrapolation.CLAMP) },
    ],
  }));
  const copy = useAnimatedStyle(() => ({
    opacity: interpolate(x.get(), [(index - 0.6) * width, index * width, (index + 0.6) * width], [0, 1, 0], Extrapolation.CLAMP),
    transform: [
      { translateX: interpolate(x.get(), [(index - 1) * width, index * width, (index + 1) * width], [width * 0.15, 0, -width * 0.15], Extrapolation.CLAMP) },
    ],
  }));

  const status = series.anime
    ? series.status === 'completed' ? 'Saison terminée' : `Saison 1 · ${eps.length} épisodes`
    : `${series.manhwa!.chapters.length} chapitres`;

  return (
    <View style={{ width, height: HERO_H, overflow: 'hidden' }}>
      <Animated.View style={[StyleSheet.absoluteFill, art]}>
        <Cover palette={series.palette} image={series.image} width={width} height={HERO_H} radius={0} shade="strong" />
      </Animated.View>
      {/* Top scrim so the brand and status bar stay legible on busy key art. */}
      <LinearGradient pointerEvents="none" colors={['rgba(5,7,13,0.8)', 'rgba(5,7,13,0)']} style={styles.topScrim} />
      <Animated.View style={[styles.copy, copy]}>
        <Chip kind="accent" label={status} />
        <Txt v="display" numberOfLines={2} style={{ fontSize: 34, lineHeight: 38 }}>{series.title}</Txt>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {series.anime && <Chip kind="anime" />}
          {series.manhwa && <Chip kind="manhwa" />}
          {series.genres.map((g) => <Chip key={g} kind="neutral" label={g} />)}
        </View>
        <Txt v="body" numberOfLines={2} color={C.body}>{series.synopsis}</Txt>
        <View style={{ flexDirection: 'row', gap: S.sm, marginTop: 4 }}>
          {resume && (
            <Button icon="play" label={`Regarder · Ép. ${resume.number}`} onPress={() => router.push(`/watch/${resume.id}`)} style={{ flex: 1 }} />
          )}
          {nextCh && (
            <Button
              variant="soft"
              icon="book"
              label={`Lire · Ch. ${nextCh.number}`}
              onPress={() => router.push(`/read/${nextCh.id}`)}
              style={{ flex: resume ? undefined : 1 }}
            />
          )}
        </View>
      </Animated.View>
    </View>
  );
}

function Dot({ index, x, width }: { index: number; x: SharedValue<number>; width: number }) {
  const style = useAnimatedStyle(() => {
    const p = interpolate(x.get(), [(index - 1) * width, index * width, (index + 1) * width], [0, 1, 0], Extrapolation.CLAMP);
    return { width: 6 + p * 16, opacity: 0.35 + p * 0.65 };
  });
  return <Animated.View style={[styles.dot, style]} />;
}

const styles = StyleSheet.create({
  topScrim: { position: 'absolute', left: 0, right: 0, top: 0, height: 170 },
  copy: { position: 'absolute', left: S.lg, right: S.lg, bottom: 44, gap: 10 },
  dots: { position: 'absolute', bottom: 18, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot: { height: 6, borderRadius: 3, backgroundColor: C.accentText },
});
