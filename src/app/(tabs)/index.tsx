import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { Extrapolation, interpolate, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ContinueCard, RankCard, ReleaseCard } from '@/components/cards';
import { HeroCarousel } from '@/components/hero';
import { PRIORITY, usePresearch } from '@/components/presearch';
import { Cover, IconButton, Press, SectionHeader, Txt, Wordmark } from '@/components/ui';
import { continuationChapter, hasBoth } from '@/data/bridge';
import { allSeries, animeSeries, episodeLabel, getEpisode, useCatalog } from '@/data/catalog';
import { animeReleases, manhwaReleases, weeklyTop } from '@/data/releases';
import { useContinueItems } from '@/store/derived';
import { useStore } from '@/store/store';
import { C, R, S, SHADOW } from '@/theme/tokens';


export default function Home() {
  const insets = useSafeAreaInsets();
  const catalogVersion = useCatalog();
  const continueItems = useContinueItems();
  // The most recent "Reprendre" episode is pre-searched once the row has been on screen a second.
  const resume = continueItems.find((i) => i.kind === 'anime' && !i.bridged);
  const resumeEp = resume ? getEpisode(resume.key) : undefined;
  usePresearch(
    'continue',
    resumeEp
      ? { seriesId: resumeEp.series.id, episodeId: resumeEp.episode.id, episode: resumeEp.episode.number, meta: { title: resumeEp.series.title, artist: episodeLabel(resumeEp.episode), artwork: resumeEp.series.image } }
      : null,
    PRIORITY.continue,
  );
  // Recomputed when AniList data replaces the cached / demo catalog.
  const { featured, animeOut, manhwaOut, top } = useMemo(() => {
    void catalogVersion;
    const trending = [...animeSeries()].sort((a, b) => (a.trendRank ?? 99) - (b.trendRank ?? 99));
    return {
      featured: trending.slice(0, 5),
      animeOut: animeReleases(),
      manhwaOut: manhwaReleases(),
      top: weeklyTop(),
    };
  }, [catalogVersion]);
  const episodes = useStore((s) => s.episodes);
  // Series watched as anime that continue in the manhwa.
  const bridges = allSeries().filter((s) => hasBoth(s) && s.anime!.episodes.some((e) => episodes[e.id]));
  // The header gains a solid backdrop once the hero has scrolled away (purpose: legibility).
  const { width } = useWindowDimensions();
  const y = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({ onScroll: (e) => { y.set(e.contentOffset.y); } });
  const fadeFrom = width * 0.9;
  const barBg = useAnimatedStyle(() => ({ opacity: interpolate(y.get(), [fadeFrom - 120, fadeFrom], [0, 1], Extrapolation.CLAMP) }));

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingBottom: insets.bottom + 110 }}
        showsVerticalScrollIndicator={false}>
        <HeroCarousel key={featured.map((s) => s.id).join()} items={featured} />

        {continueItems.length > 0 && (
          <>
            <SectionHeader title="Reprendre" action="Historique" onAction={() => router.push('/library')} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
              {continueItems.map((item) => <ContinueCard key={item.key} item={item} />)}
            </ScrollView>
          </>
        )}

        <SectionHeader title="Prochaines sorties" action="Calendrier" onAction={() => router.push('/calendar')} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
          {animeOut.map((r) => <ReleaseCard key={r.key} release={r} />)}
        </ScrollView>

        {bridges.length > 0 && (
          <>
            <SectionHeader title="Vu l’anime ? Lis la suite" subtitle="L’histoire continue dans le manhwa" />
            <View style={{ paddingHorizontal: S.lg, gap: S.sm }}>
              {bridges.map((s) => {
                const ch = continuationChapter(s)!;
                return (
                  <Press key={s.id} onPress={() => router.push(`/read/${ch.id}`)} style={styles.bridgeRow} accessibilityLabel={`${s.title}, reprendre au chapitre ${ch.number}`}>
                    <Cover palette={s.palette} image={s.image} width={48} height={66} radius={8} />
                    <View style={{ flex: 1, gap: 3 }}>
                      <Txt v="label" numberOfLines={1}>{s.title}</Txt>
                      <Txt v="footnote" numberOfLines={1} tabular>Fin de l’anime · reprends au ch. {ch.number}</Txt>
                    </View>
                    <View style={styles.bridgeGo}>
                      <Ionicons name="arrow-forward" size={16} color={C.onAccent} />
                    </View>
                  </Press>
                );
              })}
            </View>
          </>
        )}

        <SectionHeader title="Top 10 de la semaine" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.rail, { gap: S.sm }]}>
          {top.map((t, i) => <RankCard key={t.series.id} series={t.series} kind={t.kind} rank={i + 1} />)}
        </ScrollView>

        <SectionHeader title="Manhwa tendance" action="Tout voir" onAction={() => router.push('/manhwa')} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
          {manhwaOut.map((r) => <ReleaseCard key={r.key} release={r} />)}
        </ScrollView>
      </Animated.ScrollView>

      {/* Header: brand + actions. Transparent over the hero, solid once content passes under it. */}
      <View style={[styles.topBar, { paddingTop: insets.top + 4 }]} pointerEvents="box-none">
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.barBg, barBg]} />
        <Wordmark size={24} />
        <View style={{ flexDirection: 'row', gap: S.sm }}>
          <IconButton icon="calendar-outline" label="Calendrier des sorties" size={40} onPress={() => router.push('/calendar')} />
          <IconButton icon="search" label="Rechercher" size={40} onPress={() => router.push('/search')} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { paddingHorizontal: S.lg, gap: S.md },
  topBar: {
    position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: S.lg, paddingBottom: S.sm,
  },
  barBg: { backgroundColor: 'rgba(5,7,13,0.94)', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.hairline },
  bridgeRow: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.sm, paddingRight: S.md,
    borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
    boxShadow: `${SHADOW.raised}, ${SHADOW.inset}`,
  },
  bridgeGo: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', boxShadow: SHADOW.insetStrong },
});
