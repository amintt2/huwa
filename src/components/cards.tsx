import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { traceTap } from '@/addons/timing';
import type { Series } from '@/data/catalog';
import { firstEpisodeOf, useSeasonNumber } from '@/data/franchise';
import type { Release } from '@/data/releases';
import type { ContinueItem } from '@/store/derived';
import { C, F, R, S, type Kind } from '@/theme/tokens';

import { Cover, InfoPill, Press, Progress, TypeBadge, Txt } from './ui';

const seriesHref = (s: Series, kind: Kind) => (kind === 'anime' ? (`/anime/${s.id}` as const) : (`/manhwa/${s.id}` as const));

/** Portrait poster with a type badge; used in grids and simple rails. */
export function PosterCard({ series, kind, width = 116 }: { series: Series; kind: Kind; width?: number }) {
  return (
    <Press onPress={() => router.push(seriesHref(series, kind))} style={{ width, gap: 8 }} accessibilityLabel={`${series.title}, ${kind}`}>
      <Cover palette={series.palette} image={series.image} width={width} height={width * 1.42}>
        <TypeBadge kind={kind} />
        {kind === 'anime' && series.rating > 0 && (
          <View style={styles.score}>
            <Ionicons name="star" size={9} color={C.accentText} />
            <Txt v="caption" color={C.text} style={{ fontSize: 10 }}>{series.rating.toFixed(1)}</Txt>
          </View>
        )}
      </Cover>
      <Txt v="caption" color={C.text} numberOfLines={2} style={styles.posterTitle}>{series.title}</Txt>
    </Press>
  );
}

/** Release card: art on top, centered uppercase title, info pills underneath. */
export function ReleaseCard({ release, width = 168 }: { release: Release; width?: number }) {
  const { series, kind } = release;
  const anime = kind === 'anime' && !!series.anime;
  const season = useSeasonNumber(series, anime);
  // "S3 · Épisode 7": the airing episode is rarely the show's first.
  const label = anime && season && season > 1 ? `S${season} · ${release.label}` : release.label;
  const first = series.anime?.episodes[0];
  const showStart = anime && (season === undefined || season > 1 || (series.anime!.episodes.length > 1 && !!first));
  const startOver = async () => {
    const ep = await firstEpisodeOf(series);
    if (ep) router.push(`/watch/${ep.id}`);
  };
  return (
    <Press onPress={() => router.push(release.href)} style={[styles.release, { width }]} accessibilityLabel={`${series.title}, ${label}, ${release.when}`}>
      <Cover palette={series.palette} image={series.image} width={width - 2} height={(width - 2) * 0.62} radius={0}>
        <TypeBadge kind={kind} />
        {release.tag && (
          <View style={styles.newTag}>
            <Txt v="caption" color={C.onAccent} style={{ fontSize: 9 }}>{release.tag}</Txt>
          </View>
        )}
      </Cover>
      <View style={styles.releaseBody}>
        <Txt v="caption" color={C.text} numberOfLines={2} style={[styles.posterTitle, { fontSize: 13, lineHeight: 16, minHeight: 32 }]}>{series.title}</Txt>
        <View style={styles.releaseRule} />
        <InfoPill icon={kind === 'anime' ? 'tv-outline' : 'book-outline'} label={label} tone={release.tag ? 'accent' : 'neutral'} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ flex: 1 }}>
            <InfoPill icon="time-outline" label={release.when} />
          </View>
          {showStart && (
            <Press onPress={startOver} hitSlop={8} style={styles.startOver} accessibilityRole="button" accessibilityLabel="Regarder depuis la saison 1, épisode 1">
              <Txt v="caption" color={C.accentText} style={{ fontSize: 10 }}>S1 Ép. 1</Txt>
            </Press>
          )}
        </View>
      </View>
    </Press>
  );
}

/** Top-10 card: giant outlined rank number tucked behind the poster. */
export function RankCard({ series, rank, kind }: { series: Series; rank: number; kind: Kind }) {
  return (
    <Press onPress={() => router.push(seriesHref(series, kind))} style={styles.rank} accessibilityLabel={`Numéro ${rank}, ${series.title}`}>
      <Text style={styles.rankNum} allowFontScaling={false}>{rank}</Text>
      <Cover palette={series.palette} image={series.image} width={112} height={160} style={{ marginLeft: rank >= 10 ? 62 : 44 }}>
        <TypeBadge kind={kind} />
      </Cover>
    </Press>
  );
}

export function ContinueCard({ item, width = 208 }: { item: ContinueItem; width?: number }) {
  return (
    <Press onPress={() => {
      if (item.kind === 'anime') traceTap(item.key);
      router.push(item.href);
    }} style={{ width, gap: 8 }} accessibilityLabel={`${item.series.title}, ${item.label}`}>
      <Cover
        palette={item.series.palette} image={item.series.image}
        width={width}
        height={Math.round(width * 0.56)}
        shade
        style={item.bridged && { borderWidth: 1.5, borderColor: C.accentText }}>
        {item.bridged ? (
          <View style={styles.bridgeBadge}>
            <Ionicons name="swap-horizontal" size={10} color={C.onAccent} />
            <Txt v="caption" color={C.onAccent} style={{ fontSize: 9 }}>Suite de l’anime</Txt>
          </View>
        ) : (
          <TypeBadge kind={item.kind} />
        )}
        <View style={styles.playRound}>
          <Ionicons name={item.kind === 'anime' ? 'play' : 'book'} size={15} color={C.bg} style={item.kind === 'anime' ? { marginLeft: 2 } : undefined} />
        </View>
        {item.progress > 0 && (
          <View style={styles.progress}>
            <Progress value={item.progress} color={C.accentText} track="rgba(255,255,255,0.22)" />
          </View>
        )}
      </Cover>
      <View style={{ gap: 2 }}>
        <Txt v="caption" color={C.text} numberOfLines={1} style={{ fontSize: 12 }}>{item.series.title}</Txt>
        <Txt v="small" numberOfLines={1}>{item.label} · {item.sub}</Txt>
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  score: {
    position: 'absolute', right: 8, top: 8, flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingVertical: 3, paddingHorizontal: 6, borderRadius: R.chip, backgroundColor: 'rgba(5,7,13,0.72)',
  },
  posterTitle: { textAlign: 'center', fontSize: 12, lineHeight: 15, ...F.heavy, letterSpacing: 0.5 },
  release: {
    borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface,
    borderWidth: 1, borderColor: C.border, overflow: 'hidden',
  },
  startOver: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: R.pill, borderWidth: 1, borderColor: C.accentLine, backgroundColor: C.accentSoft },
  releaseBody: { padding: S.md, gap: 8, alignItems: 'stretch' },
  releaseRule: { height: 1, backgroundColor: C.border, marginVertical: 2 },
  newTag: {
    position: 'absolute', right: 8, top: 8, paddingVertical: 3, paddingHorizontal: 6,
    borderRadius: R.chip, backgroundColor: C.accent,
  },
  rank: { flexDirection: 'row', alignItems: 'flex-end' },
  rankNum: {
    position: 'absolute', left: -2, bottom: -22, fontSize: 132, lineHeight: 150, ...F.black,
    color: C.bg, letterSpacing: -8,
    textShadowColor: 'rgba(127,176,255,0.95)', textShadowRadius: 1.5, textShadowOffset: { width: 0, height: 0 },
  },
  bridgeBadge: {
    position: 'absolute', left: 8, top: 8, flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 3, paddingHorizontal: 6, borderRadius: R.chip, backgroundColor: C.accent,
  },
  playRound: {
    position: 'absolute', right: 10, bottom: 12, width: 34, height: 34, borderRadius: 17,
    backgroundColor: C.white, alignItems: 'center', justifyContent: 'center',
  },
  progress: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
