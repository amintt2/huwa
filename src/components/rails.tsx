// Shared browse UI: poster tile, horizontal section rail ("Featured", "Tendances"… with a "Voir
// tout" chevron) and the 3-column poster grid. Fixed sizes everywhere so lists can use
// getItemLayout (no measuring while scrolling). Used by the Manhwa tab; reusable by Anime.
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactElement } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions, type ListRenderItem } from 'react-native';

import type { Palette } from '@/data/catalog';
import { C, F, R, S } from '@/theme/tokens';

import { ScoreBadge } from './cards';
import { Cover, Press, Txt } from './ui';

export const POSTER_RATIO = 1.42;
const TITLE_H = 32;
const GAP = 8;

/** Total height of a tile for a given width (poster + gap + two title lines). */
export const tileHeight = (width: number) => Math.round(width * POSTER_RATIO) + GAP + TITLE_H;

export type TileProps = {
  title: string;
  image?: string;
  imageHeaders?: Record<string, string>;
  palette: Palette;
  width: number;
  /** Score out of 10, shown as ★ 8.4. */
  rating?: number;
  /** Small label pinned bottom-left ("Ch. 20", "Téléchargé"). */
  badge?: string;
  busy?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
};

export function PosterTile({ title, image, imageHeaders, palette, width, rating, badge, busy, onPress, accessibilityLabel }: TileProps) {
  return (
    <Press onPress={onPress} style={{ width, height: tileHeight(width), gap: GAP }} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title}>
      <Cover palette={palette} image={image} imageHeaders={imageHeaders} width={width} height={Math.round(width * POSTER_RATIO)}>
        {!!rating && rating > 0 && (
          <ScoreBadge rating={rating} style={{ right: 6, top: 6 }} />
        )}
        {!!badge && (
          <View style={[styles.tag, { left: 6, bottom: 6, maxWidth: width - 12 }]}>
            <Text maxFontSizeMultiplier={1.3} style={styles.tagText} numberOfLines={1}>{badge}</Text>
          </View>
        )}
        {busy && (
          <View style={[StyleSheet.absoluteFill, styles.busy]}>
            <ActivityIndicator color={C.text} />
          </View>
        )}
      </Cover>
      <Txt v="footnote" color={C.body} numberOfLines={2} maxFontSizeMultiplier={1.2} style={styles.title}>{title}</Txt>
    </Press>
  );
}

export function RailHeader({ title, subtitle, icon, onMore, right }: { title: string; subtitle?: string; icon?: ReactElement; onMore?: () => void; right?: ReactElement }) {
  const head = (
    <View style={styles.head}>
      {icon}
      <View style={{ flexShrink: 1 }}>
        <Txt v="section" numberOfLines={1} accessibilityRole="header">{title}</Txt>
        {!!subtitle && <Txt v="footnote" numberOfLines={1}>{subtitle}</Txt>}
      </View>
      {right}
      <View style={{ flex: 1 }} />
      {onMore && (
        <View style={styles.more}>
          <Txt v="small" color={C.text2} style={F.semibold}>Tout voir</Txt>
          <Ionicons name="chevron-forward" size={14} color={C.text2} />
        </View>
      )}
    </View>
  );
  if (!onMore) return head;
  return (
    <Pressable onPress={onMore} accessibilityRole="button" accessibilityLabel={`${title}, voir tout`} hitSlop={4} style={({ pressed }) => pressed && { opacity: 0.6 }}>
      {head}
    </Pressable>
  );
}

/** Horizontal row of tiles under a header. `loading` shows skeleton tiles. */
export function Rail<T>({
  title,
  subtitle,
  icon,
  onMore,
  data,
  renderTile,
  keyOf,
  tileWidth = 116,
  loading,
  error,
  empty,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactElement;
  onMore?: () => void;
  data: T[];
  renderTile: (item: T, width: number) => ReactElement;
  keyOf: (item: T, index: number) => string;
  tileWidth?: number;
  loading?: boolean;
  error?: string;
  empty?: string;
}) {
  const step = tileWidth + S.md;
  const render: ListRenderItem<T> = ({ item }) => renderTile(item, tileWidth);
  return (
    <View style={{ gap: S.md }}>
      <RailHeader title={title} subtitle={subtitle} icon={icon} onMore={data.length ? onMore : undefined} />
      {loading && !data.length ? (
        <View style={{ flexDirection: 'row', gap: S.md, paddingHorizontal: S.lg, overflow: 'hidden' }}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={{ gap: GAP }}>
              <View style={{ width: tileWidth, height: Math.round(tileWidth * POSTER_RATIO), borderRadius: R.poster, borderCurve: 'continuous', backgroundColor: C.surface }} />
              <View style={{ width: tileWidth * 0.7, height: 10, borderRadius: 5, backgroundColor: C.surface }} />
            </View>
          ))}
        </View>
      ) : !data.length ? (
        <Txt v="footnote" style={{ paddingHorizontal: S.lg }} numberOfLines={2}>{error ?? empty ?? 'Rien pour le moment.'}</Txt>
      ) : (
        <FlatList
          horizontal
          data={data}
          keyExtractor={keyOf}
          renderItem={render}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: S.lg, gap: S.md }}
          getItemLayout={(_, index) => ({ length: step, offset: S.lg + step * index, index })}
          initialNumToRender={4}
          maxToRenderPerBatch={4}
          windowSize={3}
          style={{ height: tileHeight(tileWidth) }}
        />
      )}
    </View>
  );
}

/** Tile width for a 3-column grid on this screen. */
export function useGridTile(cols = 3) {
  const { width } = useWindowDimensions();
  return Math.floor((width - S.lg * 2 - S.md * (cols - 1)) / cols);
}

/** Grid row layout for `FlatList numColumns` (row index → offset), header height excluded. */
export const gridRowLayout = (tileW: number, header = 0) => (_: unknown, index: number) => {
  const length = tileHeight(tileW) + S.lg;
  return { length, offset: header + length * index, index };
};

const styles = StyleSheet.create({
  tag: {
    position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingVertical: 3, paddingHorizontal: 6, borderRadius: 6, borderCurve: 'continuous', backgroundColor: 'rgba(5,7,13,0.78)',
  },
  tagText: { color: C.text, fontSize: 10, ...F.semibold },
  more: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  busy: { backgroundColor: 'rgba(5,7,13,0.55)', alignItems: 'center', justifyContent: 'center' },
  title: { ...F.semibold, lineHeight: 16, height: TITLE_H },
  head: { flexDirection: 'row', alignItems: 'flex-end', gap: S.sm, paddingHorizontal: S.lg, minHeight: 36 },
});
