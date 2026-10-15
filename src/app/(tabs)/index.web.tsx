// Web home ("Board" in Stremio Web): same content as ./index.tsx — hero, Reprendre, Prochaines
// sorties, Top 10, tendances — laid out for a mouse and a wide window. From 768 px the shell's top
// bar carries search and account, so the page has no header of its own; on phones it keeps the
// native header (wordmark, calendar, search) over the hero.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ContinueCard, RankCard, ReleaseCard } from '@/components/cards';
import { HeroCarousel, HeroSkeleton } from '@/components/hero';
import { CardRailSkeleton, RailSkeleton } from '@/components/skeletons';
import { PosterTile } from '@/components/rails';
import { Cover, IconButton, Press, SectionHeader, Txt, Wordmark } from '@/components/ui';
import { continuationChapter, hasBoth } from '@/data/bridge';
import { seriesHref } from '@/data/anilist-api';
import { allSeries, animeSeries, useCatalog, useCatalogLoading } from '@/data/catalog';
import { animeReleases, manhwaReleases, weeklyTop } from '@/data/releases';
import { useContinueItems } from '@/store/derived';
import { useStore } from '@/store/store';
import { C, R, S, SHADOW } from '@/theme/tokens';
import { InstallBanner } from '@/web/install';
import { ScrollRow } from '@/web/scroll-row';
import { WIDE } from '@/web/viewport';

export default function Home() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const catalogVersion = useCatalog();
  // First visit, nothing cached yet: skeletons in the shape of the page, not the demo series.
  const loading = useCatalogLoading();
  const continueItems = useContinueItems();
  // Recomputed for each catalog version: the cache, then each refresh that changed something.
  const { featured, animeOut, manhwaOut, top, trending } = useMemo(() => homeRows(catalogVersion), [catalogVersion]);
  const episodes = useStore((s) => s.episodes);
  const bridges = loading ? [] : allSeries().filter((s) => hasBoth(s) && s.anime!.episodes.some((e) => episodes[e.id]));
  const pad = wide ? S.xxl : S.lg;
  const release = wide ? 264 : 216;
  const poster = width >= 1100 ? 160 : wide ? 140 : 116;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + (wide ? S.xxl * 2 : 110) }} showsVerticalScrollIndicator={wide}>
        {loading ? <HeroSkeleton /> : <HeroCarousel key={featured.map((s) => s.id).join()} items={featured} />}

        <View style={wide ? styles.wideBody : undefined}>
          {continueItems.length > 0 && (
            <Section title="Reprendre" action="Historique" onAction={() => router.navigate('/library')} pad={pad}>
              <ScrollRow label="Reprendre" padding={pad}>
                {continueItems.map((item) => <ContinueCard key={item.key} item={item} width={wide ? 280 : 224} />)}
              </ScrollRow>
            </Section>
          )}

          <Section title="Prochaines sorties" action="Calendrier" onAction={() => router.navigate('/calendar')} pad={pad}>
            {loading ? (
              <CardRailSkeleton width={release} pad={pad} count={6} />
            ) : (
              <ScrollRow label="Prochaines sorties" padding={pad}>
                {animeOut.map((r) => <ReleaseCard key={r.key} release={r} width={release} />)}
              </ScrollRow>
            )}
          </Section>

          {bridges.length > 0 && (
            <Section title="Vu l’anime ? Lis la suite" subtitle="L’histoire continue dans le manhwa" pad={pad}>
              <View style={{ paddingHorizontal: pad, gap: S.sm, flexDirection: wide ? 'row' : 'column', flexWrap: 'wrap' }}>
                {bridges.map((s) => {
                  const ch = continuationChapter(s)!;
                  return (
                    <Press key={s.id} onPress={() => router.push(`/read/${ch.id}`)} style={[styles.bridgeRow, wide && { width: 360 }]} accessibilityLabel={`${s.title}, reprendre au chapitre ${ch.number}`}>
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
            </Section>
          )}

          <Section title="Top 10 de la semaine" pad={pad}>
            {loading ? (
              <RailSkeleton tileWidth={116} pad={pad} count={10} title={false} />
            ) : (
              <ScrollRow label="Top 10 de la semaine" padding={pad} gap={S.sm}>
                {top.map((t, i) => <RankCard key={t.series.id} series={t.series} kind={t.kind} rank={i + 1} />)}
              </ScrollRow>
            )}
          </Section>

          {loading && (
            <Section title="Anime tendance" pad={pad}>
              <RailSkeleton tileWidth={poster} pad={pad} count={10} />
            </Section>
          )}
          {trending.length > 0 && !loading && (
            <Section title="Anime tendance" action="Tout voir" onAction={() => router.navigate('/anime')} pad={pad}>
              <ScrollRow label="Anime tendance" padding={pad}>
                {trending.map((s) => (
                  <PosterTile key={s.id} title={s.title} image={s.image} palette={s.palette} width={poster} rating={s.rating}
                    onPress={() => router.push(seriesHref(s))} accessibilityLabel={`${s.title}, anime`} />
                ))}
              </ScrollRow>
            </Section>
          )}

          <Section title="Manhwa tendance" action="Tout voir" onAction={() => router.navigate('/manhwa')} pad={pad}>
            {loading ? (
              <CardRailSkeleton width={release} pad={pad} count={6} />
            ) : (
              <ScrollRow label="Manhwa tendance" padding={pad}>
                {manhwaOut.map((r) => <ReleaseCard key={r.key} release={r} width={release} />)}
              </ScrollRow>
            )}
          </Section>
        </View>
      </ScrollView>

      {!wide && (
        <View style={[styles.topBar, { paddingTop: insets.top + 4 }]} pointerEvents="box-none">
          <Wordmark size={24} />
          <View style={{ flexDirection: 'row', gap: S.sm }}>
            <IconButton icon="calendar-outline" label="Calendrier des sorties" size={40} onPress={() => router.push('/calendar')} />
            <IconButton icon="search" label="Rechercher" size={40} onPress={() => router.push('/search')} />
          </View>
        </View>
      )}
      {/* "Installer l'app" for this platform: APK on Android, home screen on iOS, PWA on desktop. */}
      <InstallBanner />
    </View>
  );
}

/**
 * Rails of the home for a catalog version. The version is a real argument: with the React
 * Compiler, a `useMemo` that only mentions it as `void catalogVersion` lost it as a dependency
 * and kept the first catalog (the demo series) after AniList answered.
 */
function homeRows(_version: number) {
  const byTrend = [...animeSeries()].sort((a, b) => (a.trendRank ?? 99) - (b.trendRank ?? 99));
  return {
    featured: byTrend.slice(0, 5),
    trending: byTrend.slice(5, 25),
    animeOut: animeReleases(),
    manhwaOut: manhwaReleases(),
    top: weeklyTop(),
  };
}

function Section({
  title,
  subtitle,
  action,
  onAction,
  pad,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: string;
  onAction?: () => void;
  pad: number;
  children: React.ReactNode;
}) {
  return (
    <View role="region" aria-label={title}>
      <View style={{ paddingHorizontal: pad - S.lg }}>
        <SectionHeader title={title} subtitle={subtitle} action={action} onAction={onAction} />
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wideBody: { marginTop: -S.lg },
  topBar: {
    position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: S.lg, paddingBottom: S.sm,
  },
  bridgeRow: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.sm, paddingRight: S.md,
    borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
    boxShadow: `${SHADOW.raised}, ${SHADOW.inset}`,
  },
  bridgeGo: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', boxShadow: SHADOW.insetStrong },
});
