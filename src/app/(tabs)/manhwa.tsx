// Manhwa tab, Paperback-style: a strip of "sources" at the top — "Huwa" (our AniList catalog,
// sections + filters) then each installed extension (its own home sections).
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HuwaHome, HuwaSearchBar, useHuwaFilters } from '@/components/manhwa/huwa-home';
import { SourceHome } from '@/components/manhwa/source-home';
import { HUWA_TAB, SourceStrip } from '@/components/manhwa/source-strip';
import { useDownloads } from '@/components/reader/downloads';
import { Txt } from '@/components/ui';
import { activeCount } from '@/data/manhwa-filters';
import { autoLinkLibrary } from '@/manga-ext/autolink';
import { useMangaExt } from '@/manga-ext/registry';
import { useContinueItems } from '@/store/derived';
import { useStore } from '@/store/store';
import { C, R, S } from '@/theme/tokens';

/** Selected tab, kept for the session (switching app tabs doesn't reset it). */
let lastTab = HUWA_TAB;

export default function ManhwaTab() {
  const insets = useSafeAreaInsets();
  const [tab, setTabState] = useState(lastTab);
  const setTab = (k: string) => {
    lastTab = k;
    setTabState(k);
  };
  const huwa = useHuwaFilters();
  const { installed } = useMangaExt();
  const downloads = useDownloads();
  const activeDl = Object.values(downloads).filter((d) => d.status === 'queued' || d.status === 'downloading').length;

  // The selected source was disabled or removed: back to Huwa.
  const sourceGone = tab !== HUWA_TAB && !installed.some((s) => s.key === tab && s.enabled);
  const current = sourceGone ? HUWA_TAB : tab;

  // Quietly link "Ma liste" / "Continuer" series to the installed sources (a few per session).
  const myList = useStore((s) => s.myList);
  const cont = useContinueItems();
  const hasSources = installed.some((s) => s.enabled);
  useEffect(() => {
    if (!hasSources) return;
    const ids = [...cont.filter((c) => c.kind === 'manhwa').map((c) => c.series.id), ...myList];
    const t = setTimeout(() => autoLinkLibrary(ids), 4000);
    return () => clearTimeout(t);
    // Once per mount: the pass itself runs once per session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSources]);

  const bottom = insets.bottom + 56;
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingTop: insets.top + S.sm, gap: S.md, paddingBottom: S.sm }}>
        <View style={styles.titleRow}>
          <View style={{ width: 5, height: 22, borderRadius: 3, backgroundColor: C.accentText }} />
          <Txt v="display" style={{ fontSize: 28, flex: 1 }}>Manhwa</Txt>
          <Pressable onPress={() => router.push('/offline' as Href)} style={styles.round} accessibilityRole="button" accessibilityLabel={activeDl ? `Téléchargements, ${activeDl} en cours` : 'Téléchargements'}>
            <Ionicons name="arrow-down-circle-outline" size={22} color={C.text} />
            {activeDl > 0 && (
              <View style={styles.dot}>
                <Txt v="caption" color={C.onAccent} style={{ fontSize: 9 }}>{activeDl}</Txt>
              </View>
            )}
          </Pressable>
        </View>
        <SourceStrip selected={current} onSelect={setTab} />
        {current === HUWA_TAB && (
          <HuwaSearchBar value={huwa.text} onChange={huwa.setText} count={activeCount(huwa.filters)} onFilters={() => huwa.setSheet(true)} />
        )}
      </View>
      {current === HUWA_TAB ? <HuwaHome state={huwa} bottomInset={bottom} /> : <SourceHome key={current} sourceKey={current} bottomInset={bottom} />}
    </View>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingHorizontal: S.lg },
  round: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  dot: { position: 'absolute', right: -2, top: -2, minWidth: 16, height: 16, borderRadius: R.pill, paddingHorizontal: 3, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
});
