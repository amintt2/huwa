import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ContinueCard, RankCard, ReleaseCard } from '@/components/cards';
import { HeroCarousel } from '@/components/hero';
import { Cover, IconButton, Press, SectionHeader, Txt } from '@/components/ui';
import { continuationChapter, hasBoth } from '@/data/bridge';
import { allSeries, animeSeries, useCatalog } from '@/data/catalog';
import { animeReleases, manhwaReleases, weeklyTop } from '@/data/releases';
import { useContinueItems } from '@/store/derived';
import { useStore } from '@/store/store';
import { C, R, S } from '@/theme/tokens';


export default function Home() {
  const insets = useSafeAreaInsets();
  const catalogVersion = useCatalog();
  const continueItems = useContinueItems();
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

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <ScrollView
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingBottom: insets.bottom + 110 }}
        showsVerticalScrollIndicator={false}>
        <View>
          <HeroCarousel items={featured} />
          {/* Brand + search ride with the hero, so they never cover content further down. */}
          <View style={[styles.topBar, { top: insets.top + 4 }]} pointerEvents="box-none">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Txt v="display" style={{ fontSize: 26, letterSpacing: 1 }}>huwa</Txt>
              <View style={styles.logoDot} />
            </View>
            <IconButton icon="search" label="Rechercher" onPress={() => router.push('/anime')} />
          </View>
        </View>

        {continueItems.length > 0 && (
          <>
            <SectionHeader title="Reprendre" icon="play-circle-outline" action="Historique" onAction={() => router.push('/library')} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
              {continueItems.map((item) => <ContinueCard key={item.key} item={item} />)}
            </ScrollView>
          </>
        )}

        <SectionHeader title="Prochaines sorties" icon="calendar-outline" action="Tout voir" onAction={() => router.push('/anime')} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
          {animeOut.map((r) => <ReleaseCard key={r.key} release={r} />)}
        </ScrollView>

        {bridges.length > 0 && (
          <>
            <SectionHeader title="Vu l’anime ? Lis la suite" icon="swap-horizontal" />
            <View style={{ paddingHorizontal: S.lg, gap: S.sm }}>
              {bridges.map((s) => {
                const ch = continuationChapter(s)!;
                return (
                  <Press key={s.id} onPress={() => router.push(`/read/${ch.id}`)} style={styles.bridgeRow} accessibilityLabel={`${s.title}, reprendre au chapitre ${ch.number}`}>
                    <Cover palette={s.palette} image={s.image} width={48} height={64} radius={8} />
                    <View style={{ flex: 1, gap: 3 }}>
                      <Txt v="caption" color={C.text} style={{ fontSize: 13 }} numberOfLines={1}>{s.title}</Txt>
                      <Txt v="small" numberOfLines={1}>Fin de l’anime · reprends au ch. {ch.number}</Txt>
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

        <SectionHeader title="Top 10 de la semaine" icon="flame-outline" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.rail, { gap: S.xl, paddingTop: 4 }]}>
          {top.map((t, i) => <RankCard key={t.series.id} series={t.series} kind={t.kind} rank={i + 1} />)}
        </ScrollView>

        <SectionHeader title="Manhwa tendance" icon="book-outline" action="Tout voir" onAction={() => router.push('/manhwa')} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
          {manhwaOut.map((r) => <ReleaseCard key={r.key} release={r} />)}
        </ScrollView>
      </ScrollView>

      {/* Keeps the status bar legible while content scrolls under the Dynamic Island. */}
      <LinearGradient
        pointerEvents="none"
        colors={[C.bg, 'rgba(5,7,13,0.7)', 'rgba(5,7,13,0)']}
        style={[styles.topFade, { height: insets.top + 20 }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { paddingHorizontal: S.lg, gap: S.md },
  topFade: { position: 'absolute', left: 0, right: 0, top: 0 },
  topBar: { position: 'absolute', left: S.lg, right: S.lg, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  logoDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.accentText, marginTop: 8 },
  bridgeRow: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, padding: 10,
    borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  bridgeGo: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
});
