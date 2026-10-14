// Web build of ./rails (same exports). Phone rails scroll with a swipe; on the web:
// · `Rail` pages with chevrons on hover (src/web/scroll-row.tsx) and shows every tile (a few
//   dozen at most: no virtualization needed);
// · `PosterTile` lifts on hover and shows a focus ring for keyboard users;
// · `useGridTile` caps the tile width: a 3-column phone grid stretched to 1200 px gave 380 px
//   posters. Grids keep their column count (numColumns is fixed by the screens).
import { ActivityIndicator, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { C, F, R, S } from '@/theme/tokens';
import { hoverRing, HoverPress } from '@/web/hover-press';
import { ScrollRow } from '@/web/scroll-row';

import { ScoreBadge } from './cards';
import { Cover, Txt } from './ui';

import type * as Base from './rails';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const base: typeof Base = require('./rails.tsx');

export const { POSTER_RATIO, tileHeight, RailHeader, gridRowLayout } = base;
export type { TileProps } from './rails';

const TITLE_H = 32;
const GAP = 8;
const MAX_TILE = 176;

export function PosterTile({ title, image, imageHeaders, palette, width, rating, badge, busy, onPress, accessibilityLabel }: Base.TileProps) {
  return (
    <HoverPress onPress={onPress} style={{ width, height: tileHeight(width), gap: GAP }} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title}>
      {({ hovered, focused }) => (
        <>
          <Cover palette={palette} image={image} imageHeaders={imageHeaders} width={width} height={Math.round(width * POSTER_RATIO)}>
            {!!rating && rating > 0 && <ScoreBadge rating={rating} style={{ right: 6, top: 6 }} />}
            {!!badge && (
              <View style={[styles.tag, { left: 6, bottom: 6, maxWidth: width - 12 }]}>
                <Text style={styles.tagText} numberOfLines={1}>{badge}</Text>
              </View>
            )}
            {busy && (
              <View style={[StyleSheet.absoluteFill, styles.busy]}>
                <ActivityIndicator color={C.text} />
              </View>
            )}
            <View pointerEvents="none" style={hoverRing(hovered || focused)} />
          </Cover>
          <Txt v="footnote" color={hovered ? C.text : C.body} numberOfLines={2} style={styles.title}>{title}</Txt>
        </>
      )}
    </HoverPress>
  );
}

export function Rail<T>(props: Parameters<typeof Base.Rail<T>>[0]) {
  const { title, subtitle, icon, onMore, data, renderTile, keyOf, tileWidth = 116, loading, error, empty } = props;
  const { width } = useWindowDimensions();
  // Wider tiles on large screens, like the rest of the board.
  const tile = width >= 1100 ? Math.max(tileWidth, 150) : width >= 768 ? Math.max(tileWidth, 132) : tileWidth;
  return (
    <View style={{ gap: S.md }}>
      <RailHeader title={title} subtitle={subtitle} icon={icon} onMore={data.length ? onMore : undefined} />
      {loading && !data.length ? (
        <View style={{ flexDirection: 'row', gap: S.md, paddingHorizontal: S.lg, overflow: 'hidden' }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <View key={i} style={{ gap: GAP }}>
              <View style={{ width: tile, height: Math.round(tile * POSTER_RATIO), borderRadius: R.poster, borderCurve: 'continuous', backgroundColor: C.surface }} />
              <View style={{ width: tile * 0.7, height: 10, borderRadius: 5, backgroundColor: C.surface }} />
            </View>
          ))}
        </View>
      ) : !data.length ? (
        <Txt v="footnote" style={{ paddingHorizontal: S.lg }} numberOfLines={2}>{error ?? empty ?? 'Rien pour le moment.'}</Txt>
      ) : (
        <ScrollRow label={title}>
          {data.map((item, i) => (
            <View key={keyOf(item, i)}>{renderTile(item, tile)}</View>
          ))}
        </ScrollRow>
      )}
    </View>
  );
}

export function useGridTile(cols = 3) {
  const { width } = useWindowDimensions();
  return Math.min(MAX_TILE, Math.floor((width - S.lg * 2 - S.md * (cols - 1)) / cols));
}

const styles = StyleSheet.create({
  tag: {
    position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingVertical: 3, paddingHorizontal: 6, borderRadius: 6, borderCurve: 'continuous', backgroundColor: 'rgba(5,7,13,0.78)',
  },
  tagText: { color: C.text, fontSize: 10, ...F.semibold },
  busy: { backgroundColor: 'rgba(5,7,13,0.55)', alignItems: 'center', justifyContent: 'center' },
  title: { ...F.semibold, lineHeight: 16, height: TITLE_H },
});
