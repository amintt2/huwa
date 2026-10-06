// Season picker of the anime page (model: data/season-view.ts). Rows are seasons as people know
// them: AniList parts grouped ("Saison 4 · 2 parties"), TheTVDB sub-seasons of long-runners
// (One Piece "Saison 21", a range of its episodes), then "Films & spéciaux". Picking a season of
// another AniList entry switches the page to it; a sub-season only filters the episode list.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';

import { openMedia } from '@/data/anilist-api';
import { palette } from '@/data/anilist';
import { getSeries } from '@/data/catalog';
import { SPECIALS_KEY, monthLabel, type SeasonView, type SpecialRow } from '@/data/season-view';
import { seasonDetail, type DisplaySeason } from '@/data/seasons';
import { useStore } from '@/store/store';
import { C, F, R, S, TABULAR } from '@/theme/tokens';

import { Sheet, SheetLabel, SheetOption } from './sheet';
import { Cover, Press, Txt } from './ui';

/** "Saison 3 ▾" (or "Films & spéciaux ▾"), next to the "Épisodes" tab. */
export function SeasonButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Press onPress={onPress} haptics="select" hitSlop={8} style={styles.button}
      accessibilityRole="button" accessibilityLabel={label} accessibilityHint="Choisir une autre saison">
      <Text maxFontSizeMultiplier={1.4} numberOfLines={1} style={styles.buttonText}>{label}</Text>
      <Ionicons name="chevron-down" size={14} color={C.text} />
    </Press>
  );
}

/** Episodes of a season seen / started, for its row ("Vue", "3/28 vus"). */
function useWatched(s: DisplaySeason): string | null {
  const progress = useStore((st) => st.episodes);
  let seen = 0;
  let started = false;
  let total = 0;
  for (const p of s.parts) {
    const eps = getSeries(p.seriesId)?.anime?.episodes.slice(p.from - 1, p.to) ?? [];
    total += eps.length;
    for (const e of eps) {
      const x = progress[e.id];
      if (x) started = true;
      if (x?.done) seen++;
    }
  }
  return seen === total && total > 0 ? 'Vue' : started ? `${seen}/${total} vus` : null;
}

function SeasonRow({ season, on, onPress }: { season: DisplaySeason; on: boolean; onPress: () => void }) {
  const watched = useWatched(season);
  return (
    <>
      {season.header && <SheetLabel>{season.header}</SheetLabel>}
      <SheetOption title={season.label} detail={[seasonDetail(season, monthLabel), watched].filter(Boolean).join(' · ')} on={on} onPress={onPress} />
    </>
  );
}

/** Every season, the current one checked, then the specials. */
export function SeasonSheet({
  view,
  title,
  visible,
  onClose,
  onPick,
}: {
  view: SeasonView;
  title?: string;
  visible: boolean;
  onClose: () => void;
  onPick: (season: DisplaySeason | typeof SPECIALS_KEY) => void;
}) {
  const specialsLabel = view.specials.some((x) => x.format === 'MOVIE') ? 'Films & spéciaux' : 'Spéciaux';
  return (
    <Sheet visible={visible} onClose={onClose} detents="fit" title="Saisons" subtitle={title} contentGap={8}>
      {view.seasons.map((s) => (
        <SeasonRow key={s.key} season={s} on={!view.showSpecials && s.key === view.selected?.key}
          onPress={() => (s.key === view.selected?.key && !view.showSpecials ? onClose() : onPick(s))} />
      ))}
      {view.specials.length > 0 && (
        <SheetOption
          title={specialsLabel}
          detail={`${view.specials.length} ${view.specials.length > 1 ? 'titres' : 'titre'}`}
          on={view.showSpecials}
          onPress={() => (view.showSpecials ? onClose() : onPick(SPECIALS_KEY))}
          icon={<Ionicons name="film-outline" size={18} color={view.showSpecials ? C.accentText : C.text2} />}
        />
      )}
    </Sheet>
  );
}

/** One special (movie, OVA, recap): opens its own page. */
function SpecialItemRow({ item }: { item: SpecialRow }) {
  const [opening, setOpening] = useState(false);
  const known = getSeries(`al${item.anilistId}`);
  const open = async () => {
    if (opening) return;
    setOpening(true);
    try {
      router.push(await openMedia(item.anilistId, 'ANIME'));
    } catch {
      Alert.alert(item.title, 'Impossible d’ouvrir ce titre pour le moment.');
    } finally {
      setOpening(false);
    }
  };
  const count = item.episodes && item.episodes > 1 ? `${item.episodes} ép.` : null;
  const when = item.start ?? (item.year ? String(item.year) : null);
  return (
    <Press onPress={open} scaleTo={0.98} style={styles.special}
      accessibilityLabel={[item.kind, item.title, item.when].filter(Boolean).join(', ')}>
      <Cover palette={known?.palette ?? palette(null)} image={item.image ?? known?.image} width={56} height={80} radius={8} />
      <View style={{ flex: 1, gap: 3 }}>
        <Txt v="caption" color={C.accentText}>{item.kind}</Txt>
        <Txt v="label" numberOfLines={2}>{item.title}</Txt>
        <Txt v="footnote" numberOfLines={1}>
          {[when && (when.length > 4 ? monthLabel(when) : when), count, item.when].filter(Boolean).join(' · ')}
        </Txt>
      </View>
      {opening ? <ActivityIndicator color={C.text2} /> : <Ionicons name="chevron-forward" size={16} color={C.text3} />}
    </Press>
  );
}

/** "Films & spéciaux" in place of the episode rows, in airing order. */
export function SpecialsList({ items }: { items: SpecialRow[] }) {
  return (
    <View style={{ gap: S.md }}>
      {items.map((x) => <SpecialItemRow key={x.anilistId} item={x} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row', alignItems: 'center', gap: 4, height: 32, paddingHorizontal: 12, alignSelf: 'center', maxWidth: 200,
    borderRadius: R.pill, borderCurve: 'continuous', backgroundColor: C.elevated,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  buttonText: { color: C.text, fontSize: 14, flexShrink: 1, ...F.semibold, ...TABULAR },
  special: { flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 80 },
});
