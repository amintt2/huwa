// Layout skeletons: the shape of each screen while its data is not there yet, built from the
// Skeleton primitive (./skeleton). Same sizes as the real rows and cards, so nothing jumps when the
// content replaces them. Containers carry the "Chargement" label for screen readers.
import { router } from 'expo-router';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { C, R, S } from '@/theme/tokens';

import { useBackdropHeight } from './detail';
import { Skeleton } from './skeleton';
import { IconButton } from './ui';

const POSTER_RATIO = 1.42;
const LABEL = { accessibilityLabel: 'Chargement', accessibilityRole: 'progressbar' as const };

/** A text line. */
export function LineSkeleton({ width, height = 12, tint, style }: { width: number | `${number}%`; height?: number; tint?: string; style?: object }) {
  return <Skeleton width={width} height={height} radius={height / 2.5} tint={tint} style={style} />;
}

/** Section title ("Prochaines sorties") over a rail. */
export function SectionHeaderSkeleton({ pad = S.lg }: { pad?: number }) {
  return (
    <View style={{ paddingHorizontal: pad, paddingTop: 30, paddingBottom: 12 }}>
      <LineSkeleton width={170} height={20} />
    </View>
  );
}

/** Row of portrait posters with their title line (Rail, tendances, Top 10 without numbers). */
export function RailSkeleton({ tileWidth = 116, count = 6, pad = S.lg, gap = S.md, title = true }: { tileWidth?: number; count?: number; pad?: number; gap?: number; title?: boolean }) {
  return (
    <View {...LABEL} style={[styles.row, { gap, paddingHorizontal: pad }]}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={{ width: tileWidth, gap: 8 }}>
          <Skeleton width={tileWidth} height={Math.round(tileWidth * POSTER_RATIO)} radius={R.poster} />
          {title && <LineSkeleton width={Math.round(tileWidth * (0.8 - (i % 3) * 0.12))} height={11} />}
        </View>
      ))}
    </View>
  );
}

/** Row of 16:9 cards with two lines under each (Prochaines sorties, Reprendre). */
export function CardRailSkeleton({ width = 216, count = 4, pad = S.lg }: { width?: number; count?: number; pad?: number }) {
  return (
    <View {...LABEL} style={[styles.row, { gap: S.md, paddingHorizontal: pad }]}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={{ width, gap: 10 }}>
          <Skeleton width={width} height={Math.round(width * 0.5625)} radius={R.poster} />
          <View style={{ gap: 6 }}>
            <LineSkeleton width={Math.round(width * (0.75 - (i % 2) * 0.15))} height={13} />
            <LineSkeleton width={Math.round(width * 0.4)} height={11} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Episode rows of a series page: 16:9 thumbnail, title and one line. */
export function EpisodeRowsSkeleton({ count = 6 }: { count?: number }) {
  return (
    <View {...LABEL} style={{ gap: S.lg }}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 77 }}>
          <Skeleton width={136} height={77} radius={8} />
          <View style={{ flex: 1, gap: 8 }}>
            <LineSkeleton width={`${78 - (i % 3) * 14}%`} height={14} />
            <LineSkeleton width={`${46 + (i % 2) * 12}%`} height={11} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Chapter rows of a manhwa page (and a source's chapter list). */
export function ChapterRowsSkeleton({ count = 8 }: { count?: number }) {
  return (
    <View {...LABEL} style={{ gap: S.md }}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 52 }}>
          <View style={{ flex: 1, gap: 7 }}>
            <LineSkeleton width={`${60 - (i % 3) * 10}%`} height={14} />
            <LineSkeleton width={`${30 + (i % 2) * 10}%`} height={11} />
          </View>
          <Skeleton width={32} height={32} radius={16} />
        </View>
      ))}
    </View>
  );
}

/**
 * Series page before its data is known (opened from a link, catalog still loading): key art,
 * title and metadata on the art, the primary button, action tiles, synopsis and the list.
 */
export function DetailSkeleton({ kind = 'anime' }: { kind?: 'anime' | 'manhwa' }) {
  const insets = useSafeAreaInsets();
  const h = useBackdropHeight();
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }} {...LABEL}>
      <Skeleton height={h} radius={0} tint={C.surface}>
        <View style={[styles.copy]}>
          <LineSkeleton width="72%" height={30} tint={C.elevated} />
          <LineSkeleton width="48%" height={13} tint={C.elevated} />
          <LineSkeleton width="36%" height={12} tint={C.elevated} />
        </View>
      </Skeleton>
      <View style={{ paddingHorizontal: S.lg, paddingTop: S.md, gap: S.lg, paddingBottom: insets.bottom + S.xxl }}>
        <Skeleton height={56} radius={R.control} />
        <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={{ alignItems: 'center', gap: 6 }}>
              <Skeleton width={26} height={26} radius={13} />
              <LineSkeleton width={48} height={10} />
            </View>
          ))}
        </View>
        <View style={{ gap: 8 }}>
          <LineSkeleton width="100%" height={13} />
          <LineSkeleton width="94%" height={13} />
          <LineSkeleton width="62%" height={13} />
        </View>
        <LineSkeleton width={110} height={18} style={{ marginTop: S.sm }} />
        {kind === 'anime' ? <EpisodeRowsSkeleton count={5} /> : <ChapterRowsSkeleton count={7} />}
      </View>
      <View style={[styles.nav, { top: insets.top + 4 }]}>
        <IconButton icon="chevron-back" label="Retour" size={40} onPress={() => router.back()} />
      </View>
    </View>
  );
}

/** Poster grid while results load (search, "Voir tout" of a source); `width` forces the tile size. */
export function PosterGridSkeleton({ cols = 3, rows = 3, gap = S.md, pad = S.lg, ratio = POSTER_RATIO, width: forced }: { cols?: number; rows?: number; gap?: number; pad?: number; ratio?: number; width?: number }) {
  const { width } = useWindowDimensions();
  const tile = forced ?? Math.floor((width - pad * 2 - gap * (cols - 1)) / cols);
  return (
    <View {...LABEL} style={{ flexDirection: 'row', flexWrap: 'wrap', gap, paddingHorizontal: pad }}>
      {Array.from({ length: cols * rows }, (_, i) => (
        <View key={i} style={{ width: tile, gap: 8 }}>
          <Skeleton width={tile} height={Math.round(tile * ratio)} radius={R.poster} />
          <LineSkeleton width={Math.round(tile * (0.8 - (i % 3) * 0.15))} height={11} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', overflow: 'hidden' },
  copy: { position: 'absolute', left: S.lg, right: S.lg, bottom: S.lg, gap: 10 },
  nav: { position: 'absolute', left: S.lg },
});
