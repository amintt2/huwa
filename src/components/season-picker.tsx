// Season picker of the anime page: each AniList season is its own series, this switches between
// the seasons of the franchise (data/franchise.ts `useFranchiseSeasons`) as easily as an episode.
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, Text } from 'react-native';

import type { Series } from '@/data/catalog';
import { useStore } from '@/store/store';
import { C, F, R, TABULAR } from '@/theme/tokens';

import { Sheet, SheetOption } from './sheet';
import { Press } from './ui';

export type FranchiseSeasons = { seasons: Series[]; index: number };

/** "Saison 3 ▾", next to the "Épisodes" tab. */
export function SeasonButton({ index, onPress }: { index: number; onPress: () => void }) {
  return (
    <Press onPress={onPress} haptics="select" hitSlop={8} style={styles.button}
      accessibilityRole="button" accessibilityLabel={`Saison ${index + 1}`} accessibilityHint="Choisir une autre saison">
      <Text maxFontSizeMultiplier={1.4} style={styles.buttonText}>{`Saison ${index + 1}`}</Text>
      <Ionicons name="chevron-down" size={14} color={C.text} />
    </Press>
  );
}

/** "Saison 1 · 2013 · 25 ép." per season, the current one checked, progress when started. */
export function SeasonSheet({
  franchise,
  visible,
  onClose,
  onPick,
}: {
  franchise: FranchiseSeasons;
  visible: boolean;
  onClose: () => void;
  onPick: (s: Series) => void;
}) {
  const progress = useStore((st) => st.episodes);
  const { seasons, index } = franchise;
  return (
    <Sheet visible={visible} onClose={onClose} detents="fit" title="Saisons" subtitle={seasons[0]?.title} contentGap={8}>
      {seasons.map((s, i) => {
        const eps = s.anime?.episodes ?? [];
        const seen = eps.filter((e) => progress[e.id]?.done).length;
        const started = seen > 0 || eps.some((e) => progress[e.id]);
        const watched = seen === eps.length && eps.length > 0 ? 'Vue' : started ? `${seen}/${eps.length} vus` : null;
        return (
          <SheetOption
            key={s.id}
            title={`Saison ${i + 1}`}
            detail={[String(s.year), `${eps.length} ép.`, watched].filter(Boolean).join(' · ')}
            on={i === index}
            onPress={() => (i === index ? onClose() : onPick(s))}
          />
        );
      })}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row', alignItems: 'center', gap: 4, height: 32, paddingHorizontal: 12, alignSelf: 'center',
    borderRadius: R.pill, borderCurve: 'continuous', backgroundColor: C.elevated,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  buttonText: { color: C.text, fontSize: 14, ...F.semibold, ...TABULAR },
});
