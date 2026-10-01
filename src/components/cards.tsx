import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Text as SvgText } from 'react-native-svg';

import { traceTap } from '@/addons/timing';
import type { Series } from '@/data/catalog';
import { firstEpisodeOf, useSeasonNumber } from '@/data/franchise';
import type { Release } from '@/data/releases';
import type { ContinueItem } from '@/store/derived';
import { C, F, SHADOW, TABULAR, type Kind } from '@/theme/tokens';

import { Cover, Press, Progress, TypeBadge, Txt } from './ui';

const seriesHref = (s: Series, kind: Kind) => (kind === 'anime' ? (`/anime/${s.id}` as const) : (`/manhwa/${s.id}` as const));

/** Score badge "★ 8,4" pinned on a poster corner. */
export function ScoreBadge({ rating, style }: { rating: number; style?: object }) {
  return (
    <View style={[styles.score, style]} accessibilityLabel={`Note ${rating.toFixed(1)}`}>
      <Ionicons name="star" size={9} color={C.star} />
      <Text maxFontSizeMultiplier={1.3} style={styles.scoreText}>{rating.toFixed(1).replace('.', ',')}</Text>
    </View>
  );
}

/** Portrait poster, title underneath; used in grids and simple rails. */
export function PosterCard({ series, kind, width = 116 }: { series: Series; kind: Kind; width?: number }) {
  return (
    <Press onPress={() => router.push(seriesHref(series, kind))} style={{ width, gap: 8 }} accessibilityLabel={`${series.title}, ${kind}`}>
      <Cover palette={series.palette} image={series.image} width={width} height={width * 1.42}>
        {kind === 'anime' && series.rating > 0 && <ScoreBadge rating={series.rating} style={{ right: 6, top: 6 }} />}
      </Cover>
      <Txt v="footnote" color={C.body} numberOfLines={2} style={styles.posterTitle}>{series.title}</Txt>
    </Press>
  );
}

/** Upcoming / new release: 16:9 art with the airing time on it, title and episode underneath. */
export function ReleaseCard({ release, width = 216 }: { release: Release; width?: number }) {
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
  const h = Math.round(width * 0.5625);
  return (
    <View style={{ width, gap: 10 }}>
      <Press onPress={() => router.push(release.href)} style={{ gap: 10 }} accessibilityLabel={`${series.title}, ${label}, ${release.when}`}>
        <Cover palette={series.palette} image={series.image} width={width} height={h} shade>
          <TypeBadge kind={kind} />
          {release.tag && (
            <View style={styles.newTag}>
              <Text maxFontSizeMultiplier={1.3} style={styles.newTagText}>{release.tag}</Text>
            </View>
          )}
          <View style={styles.when}>
            <Ionicons name="time-outline" size={12} color={C.text} />
            <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={styles.whenText}>{release.when}</Text>
          </View>
        </Cover>
        <View style={{ gap: 2 }}>
          <Txt v="label" numberOfLines={1} style={{ fontSize: 14 }}>{series.title}</Txt>
          <Txt v="footnote" numberOfLines={1} tabular color={release.tag ? C.accentText : C.text2}>{label}</Txt>
        </View>
      </Press>
      {showStart && (
        <Press onPress={startOver} hitSlop={10} style={styles.startOver} accessibilityRole="button" accessibilityLabel="Regarder depuis la saison 1, épisode 1">
          <Ionicons name="play-skip-back" size={11} color={C.accentText} />
          <Txt v="footnote" color={C.accentText} style={F.semibold}>Depuis S1 Ép. 1</Txt>
        </Press>
      )}
    </View>
  );
}

const RANK_H = 168;
const RANK_POSTER_W = 116;

/** Top-10 card: big outlined numeral tucked behind the poster (Netflix). */
export function RankCard({ series, rank, kind }: { series: Series; rank: number; kind: Kind }) {
  const twoDigits = rank >= 10;
  const numW = twoDigits ? 104 : 66;
  return (
    <Press onPress={() => router.push(seriesHref(series, kind))} style={styles.rank} accessibilityLabel={`Numéro ${rank}, ${series.title}`}>
      <Svg width={numW + 20} height={RANK_H} style={{ position: 'absolute', left: -6, bottom: 0 }} pointerEvents="none">
        <SvgText
          x={0}
          y={RANK_H + 6}
          fontSize={RANK_H * 0.98}
          fontWeight="900"
          letterSpacing={twoDigits ? -14 : 0}
          fill={C.bg}
          stroke="rgba(190,205,235,0.75)"
          strokeWidth={2.5}>
          {String(rank)}
        </SvgText>
      </Svg>
      <Cover palette={series.palette} image={series.image} width={RANK_POSTER_W} height={RANK_H} style={{ marginLeft: numW - 14, boxShadow: SHADOW.raised }} />
    </Press>
  );
}

export function ContinueCard({ item, width = 224, badge = true }: { item: ContinueItem; width?: number; /** Hide the type badge where the screen already says it (Anime / Manhwa tab). */ badge?: boolean }) {
  const anime = item.kind === 'anime';
  return (
    <Press onPress={() => {
      if (anime) traceTap(item.key);
      router.push(item.href);
    }} style={{ width, gap: 10 }} accessibilityLabel={`${item.series.title}, ${item.label}, ${item.sub}`}>
      <Cover
        palette={item.series.palette} image={item.series.image}
        width={width}
        height={Math.round(width * 0.5625)}
        shade
        style={item.bridged && { borderWidth: 1.5, borderColor: C.accentText }}>
        {item.bridged ? (
          <View style={styles.bridgeBadge}>
            <Ionicons name="swap-horizontal" size={11} color={C.onAccent} />
            <Text maxFontSizeMultiplier={1.3} style={styles.bridgeText}>Suite de l’anime</Text>
          </View>
        ) : badge ? (
          <TypeBadge kind={item.kind} />
        ) : null}
        <View style={styles.playRound}>
          <Ionicons name={anime ? 'play' : 'book'} size={anime ? 18 : 16} color={C.white} style={anime ? { marginLeft: 2 } : undefined} />
        </View>
        {item.progress > 0 && (
          <View style={styles.progress}>
            <Progress value={item.progress} color={C.accentText} track="rgba(255,255,255,0.22)" height={3} />
          </View>
        )}
      </Cover>
      <View style={{ gap: 2 }}>
        <Txt v="label" numberOfLines={1} style={{ fontSize: 14 }}>{item.series.title}</Txt>
        <Txt v="footnote" numberOfLines={1} tabular>{item.label} · {item.sub}</Txt>
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  score: {
    position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingVertical: 3, paddingHorizontal: 6, borderRadius: 6, borderCurve: 'continuous', backgroundColor: 'rgba(5,7,13,0.72)',
  },
  scoreText: { color: C.text, fontSize: 10, ...F.bold, ...TABULAR },
  posterTitle: { ...F.semibold, lineHeight: 15 },
  startOver: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', minHeight: 24 },
  newTag: {
    position: 'absolute', right: 6, top: 6, paddingVertical: 3, paddingHorizontal: 7,
    borderRadius: 6, borderCurve: 'continuous', backgroundColor: C.accent,
  },
  newTagText: { color: C.onAccent, fontSize: 10, ...F.bold },
  when: {
    position: 'absolute', left: 8, bottom: 8, right: 8, flexDirection: 'row', alignItems: 'center', gap: 5,
  },
  whenText: { color: C.text, fontSize: 12, ...F.semibold, ...TABULAR, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4, flexShrink: 1 },
  rank: { flexDirection: 'row', alignItems: 'flex-end', height: RANK_H },
  bridgeBadge: {
    position: 'absolute', left: 6, top: 6, flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 3, paddingHorizontal: 7, borderRadius: 6, backgroundColor: C.accent,
  },
  bridgeText: { color: C.onAccent, fontSize: 10, ...F.bold },
  playRound: {
    position: 'absolute', left: '50%', top: '50%', marginLeft: -22, marginTop: -22, width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(5,7,13,0.45)', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.85)', alignItems: 'center', justifyContent: 'center',
  },
  progress: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
