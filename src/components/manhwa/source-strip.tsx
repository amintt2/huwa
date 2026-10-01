// Tab strip at the top of the Manhwa tab: "Huwa" (our AniList catalog) then one tab per
// installed + enabled source, like Paperback's home.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, type Href } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { SourceIcon } from '@/components/paperback';
import { Txt } from '@/components/ui';
import { useMangaExt } from '@/manga-ext/registry';
import { C, F, R, S } from '@/theme/tokens';

export const HUWA_TAB = 'huwa';

export function SourceStrip({ selected, onSelect }: { selected: string; onSelect: (key: string) => void }) {
  const { installed, showAdult } = useMangaExt();
  const sources = installed.filter((s) => s.enabled && (showAdult || s.contentRating !== 'ADULT'));
  const tab = (key: string, label: string, icon: React.ReactNode) => {
    const on = selected === key;
    return (
      <Pressable
        key={key}
        onPress={() => onSelect(key)}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        accessibilityLabel={label}
        style={[styles.tab, on && styles.tabOn]}>
        {icon}
        <Txt v="small" color={on ? C.text : C.text2} style={{ ...F.semibold, fontSize: 14 }} numberOfLines={1}>{label}</Txt>
      </Pressable>
    );
  };
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} accessibilityRole="tablist">
      {tab(
        HUWA_TAB,
        'Huwa',
        <View style={[styles.huwa, selected === HUWA_TAB && { backgroundColor: C.accent }]}>
          <Ionicons name="sparkles" size={12} color={C.white} />
        </View>,
      )}
      {sources.map((s) => tab(s.key, s.name, <SourceIcon source={s} size={22} />))}
      <Pressable onPress={() => router.push('/manga-sources' as Href)} style={styles.add} accessibilityRole="button" accessibilityLabel="Gérer les sources manhwa">
        <Ionicons name={sources.length ? 'add' : 'extension-puzzle-outline'} size={16} color={C.text2} />
        {!sources.length && <Txt v="small" style={{ ...F.semibold, fontSize: 13 }}>Ajouter des sources</Txt>}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: S.sm, paddingHorizontal: S.lg, paddingVertical: S.xs },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: 40, paddingLeft: 8, paddingRight: S.md,
    borderRadius: R.pill, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface, maxWidth: 200,
  },
  tabOn: { backgroundColor: C.elevated, borderColor: C.accentLine },
  huwa: { width: 22, height: 22, borderRadius: 11, backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center' },
  add: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, minWidth: 40, paddingHorizontal: S.md, justifyContent: 'center',
    borderRadius: R.pill, borderWidth: 1, borderColor: C.border, borderStyle: 'dashed',
  },
});
