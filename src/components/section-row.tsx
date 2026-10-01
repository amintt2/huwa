// Generic horizontal catalog section: header (title, optional subtitle, "Voir tout") + a
// horizontal virtualized list, skeleton cards while loading, inline error with retry.
// Content-agnostic (render prop) so the Anime and Manhwa tabs can share it.
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactElement } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { C, F, R, S } from '@/theme/tokens';

import { Txt } from './ui';

export type SectionRowProps<T> = {
  title: string;
  subtitle?: string;
  items: T[];
  keyOf: (item: T) => string;
  renderItem: (item: T, index: number) => ReactElement;
  /** Width of one card (skeletons and item layout). */
  itemWidth: number;
  /** Height of a skeleton card. */
  itemHeight: number;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onSeeAll?: () => void;
  /** Hidden when loaded and empty (default). */
  hideWhenEmpty?: boolean;
};

export function SectionRow<T>({
  title, subtitle, items, keyOf, renderItem, itemWidth, itemHeight, loading, error, onRetry, onSeeAll, hideWhenEmpty = true,
}: SectionRowProps<T>) {
  if (!loading && !error && !items.length && hideWhenEmpty) return null;
  const skeleton = loading && !items.length;
  return (
    <View style={{ gap: S.md }}>
      <View style={styles.head}>
        <View style={{ flexShrink: 1, gap: 2 }}>
          <Txt v="section" numberOfLines={1}>{title}</Txt>
          {subtitle && <Txt v="small" numberOfLines={1}>{subtitle}</Txt>}
        </View>
        {onSeeAll && (
          <Pressable onPress={onSeeAll} hitSlop={12} accessibilityRole="button" accessibilityLabel={`Voir tout : ${title}`} style={styles.seeAll}>
            <Txt v="small" color={C.accentText} style={F.semibold}>Voir tout</Txt>
            <Ionicons name="chevron-forward" size={14} color={C.accentText} />
          </Pressable>
        )}
      </View>
      {error && !items.length ? (
        <Pressable onPress={onRetry} style={styles.error} accessibilityRole="button" accessibilityLabel="Réessayer">
          <Ionicons name="cloud-offline-outline" size={18} color={C.text2} />
          <Txt v="small" style={{ flex: 1 }}>Impossible de charger cette section.</Txt>
          {onRetry && <Txt v="small" color={C.accentText} style={F.semibold}>Réessayer</Txt>}
        </Pressable>
      ) : (
        <FlatList
          horizontal
          data={skeleton ? [] : items}
          keyExtractor={keyOf}
          renderItem={({ item, index }) => renderItem(item, index)}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: S.lg, gap: S.md }}
          initialNumToRender={5}
          windowSize={5}
          getItemLayout={(_, index) => ({ length: itemWidth + S.md, offset: (itemWidth + S.md) * index, index })}
          ListEmptyComponent={
            skeleton ? (
              <View style={{ flexDirection: 'row', gap: S.md }}>
                {[0, 1, 2, 3].map((i) => (
                  <View key={i} style={{ width: itemWidth, height: itemHeight, borderRadius: R.card, backgroundColor: C.elevated }} />
                ))}
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: S.md, paddingHorizontal: S.lg },
  seeAll: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingBottom: 2 },
  error: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm, marginHorizontal: S.lg, padding: S.md,
    borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
});
