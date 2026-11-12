// First-launch introduction: four pages, skippable, shown once (Réglages → "Revoir l'introduction").
// The same for every flavor and about the library only: no watching questions (VO / VF, subtitles,
// stats) and no extensions. Those come with the first extension that plays in Huwa
// (app/playback-setup.tsx), so a fresh install never talks about playing anything.
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT, type Key } from '@/i18n';
import { setSetting, useSettings } from '@/settings/settings';
import { BRIDGE, C, S, SHADOW } from '@/theme/tokens';

import { Segmented } from './states';
import { Button, Txt, type IconName } from './ui';

type Page = { icon: IconName; title: Key; body: Key };
const PAGES: Page[] = [
  { icon: 'swap-horizontal', title: 'onb.1.title', body: 'onb.1.body' },
  { icon: 'calendar-outline', title: 'onb.2.title', body: 'onb.2.body' },
  { icon: 'tv-outline', title: 'onb.where.title', body: 'onb.where.body' },
  { icon: 'shield-checkmark-outline', title: 'onb.3.title', body: 'onb.3.body' },
];

export function Onboarding() {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const t = useT();
  const { lang } = useSettings();
  const [page, setPage] = useState(0);
  const scroller = useRef<ScrollView>(null);

  const done = () => setSetting('onboarded', true);
  const next = () => {
    if (page >= PAGES.length - 1) return done();
    scroller.current?.scrollTo({ x: (page + 1) * width, animated: true });
    setPage(page + 1);
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <LinearGradient colors={['#0F1A33', C.bg]} style={StyleSheet.absoluteFill} />
      <View style={[styles.top, { paddingTop: insets.top + S.sm }]}>
        <Segmented
          accessibilityLabel="Langue"
          style={{ width: 104 }}
          value={lang}
          onChange={(v) => setSetting('lang', v)}
          options={[{ value: 'fr', label: 'FR' }, { value: 'en', label: 'EN' }]}
        />
        {page < PAGES.length - 1 && <Button small variant="plain" label={t('onb.skip')} onPress={done} />}
      </View>

      <ScrollView
        ref={scroller}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
        style={{ flex: 1 }}>
        {PAGES.map((p) => (
          <View key={p.title} style={[styles.page, { width }]}>
            <LinearGradient colors={BRIDGE} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.badge}>
              <Ionicons name={p.icon} size={44} color={C.white} />
            </LinearGradient>
            <Txt v="display" style={{ fontSize: 28, textAlign: 'center' }} accessibilityRole="header">{t(p.title)}</Txt>
            <Txt v="body" style={{ textAlign: 'center', fontSize: 16, lineHeight: 23, maxWidth: 340 }}>{t(p.body)}</Txt>
          </View>
        ))}
      </ScrollView>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + S.lg }]}>
        <View style={styles.dots} accessibilityLabel={`${page + 1} / ${PAGES.length}`}>
          {PAGES.map((p, i) => (
            <View key={p.title} style={[styles.dot, i === page && styles.dotOn]} />
          ))}
        </View>
        <Button label={page === PAGES.length - 1 ? t('onb.start') : t('onb.next')} icon="arrow-forward" iconRight onPress={next} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: S.lg },
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: S.lg, paddingHorizontal: S.xl },
  badge: {
    width: 104, height: 104, borderRadius: 32, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', marginBottom: S.md,
    boxShadow: `0px 0px 0px 10px rgba(47,107,235,0.10), 0px 18px 40px -12px rgba(47,107,235,0.55), ${SHADOW.insetStrong}`,
  },
  bottom: { paddingHorizontal: S.lg, gap: S.lg },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.borderStrong },
  dotOn: { width: 22, backgroundColor: C.accentText },
});
