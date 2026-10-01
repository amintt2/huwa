// First-launch introduction: three pages, skippable, shown once (Réglages → "Revoir l'introduction").
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import * as WebBrowser from 'expo-web-browser';

import { EXTENSIONS_SITE } from '@/addons/recommended';
import { isStoreBuild } from '@/config/channel';
import { useT, type Key } from '@/i18n';
import { setSetting, useSettings } from '@/settings/settings';
import { BRIDGE, C, S } from '@/theme/tokens';

import { LanguagePrefs } from './language-prefs';
import { LinkPrompt } from './link-prompt';
import { RecommendedExtensions } from './recommended-extensions';
import { StatsOptIn } from './stats-opt-in';
import { FilterChip } from './states';
import { Button, Txt, type IconName } from './ui';

type Page = { icon: IconName; title: Key; body: Key; extensions?: boolean; prefs?: boolean; stats?: boolean };
const BASE: Page[] = [
  { icon: 'swap-horizontal', title: 'onb.1.title', body: 'onb.1.body' },
  { icon: 'calendar-outline', title: 'onb.2.title', body: 'onb.2.body' },
  { icon: 'shield-checkmark-outline', title: 'onb.3.title', body: 'onb.3.body' },
  { icon: 'language-outline', title: 'onb.prefs.title', body: 'onb.prefs.body', prefs: true },
  { icon: 'speedometer-outline', title: 'onb.stats.title', body: 'onb.stats.body', stats: true },
];
// AltStore PAL / sideload builds end on "add your extensions"; the App Store build does not.
const PAGES: Page[] = isStoreBuild ? BASE : [...BASE, { icon: 'extension-puzzle-outline', title: 'onb.4.title', body: 'onb.4.body', extensions: true }];

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
        <View style={{ flexDirection: 'row', gap: S.sm }}>
          <FilterChip label="FR" selected={lang === 'fr'} onPress={() => setSetting('lang', 'fr')} />
          <FilterChip label="EN" selected={lang === 'en'} onPress={() => setSetting('lang', 'en')} />
        </View>
        {page < PAGES.length - 1 && <Button small variant="ghost" label={t('onb.skip')} onPress={done} />}
      </View>

      <ScrollView
        ref={scroller}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
        style={{ flex: 1 }}>
        {PAGES.map((p) =>
          p.stats ? (
            <ScrollView key={p.title} style={{ width }} contentContainerStyle={styles.prefsPage} showsVerticalScrollIndicator={false}>
              <Txt v="display" style={{ fontSize: 28 }} accessibilityRole="header">{t(p.title)}</Txt>
              <Txt v="body" style={{ fontSize: 16, lineHeight: 23 }}>{t(p.body)}</Txt>
              <StatsOptIn />
            </ScrollView>
          ) : p.prefs ? (
            <ScrollView key={p.title} style={{ width }} contentContainerStyle={styles.prefsPage} showsVerticalScrollIndicator={false}>
              <Txt v="display" style={{ fontSize: 28 }} accessibilityRole="header">{t(p.title)}</Txt>
              <Txt v="body" style={{ fontSize: 16, lineHeight: 23 }}>{t(p.body)}</Txt>
              <LanguagePrefs />
            </ScrollView>
          ) : p.extensions ? (
            // Taller than the screen on small phones: scrolls vertically.
            <ScrollView key={p.title} style={{ width }} contentContainerStyle={styles.extPage} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <LinearGradient colors={BRIDGE} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.badge, styles.badgeSmall]}>
                <Ionicons name={p.icon} size={34} color={C.white} />
              </LinearGradient>
              <Txt v="display" style={{ fontSize: 28, textAlign: 'center' }} accessibilityRole="header">{t(p.title)}</Txt>
              <Txt v="body" style={{ textAlign: 'center', fontSize: 16, lineHeight: 23, maxWidth: 340 }}>{t(p.body)}</Txt>
              <View style={{ alignSelf: 'stretch', gap: S.md, marginTop: S.sm }}>
                <LinkPrompt />
                <RecommendedExtensions />
                <Button small variant="ghost" icon="open-outline" label={t('onb.4.more')} onPress={() => WebBrowser.openBrowserAsync(EXTENSIONS_SITE)} />
              </View>
            </ScrollView>
          ) : (
          <View key={p.title} style={[styles.page, { width }]}>
            <LinearGradient colors={BRIDGE} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.badge}>
              <Ionicons name={p.icon} size={44} color={C.white} />
            </LinearGradient>
            <Txt v="display" style={{ fontSize: 28, textAlign: 'center' }} accessibilityRole="header">{t(p.title)}</Txt>
            <Txt v="body" style={{ textAlign: 'center', fontSize: 16, lineHeight: 23, maxWidth: 340 }}>{t(p.body)}</Txt>
          </View>
          ),
        )}
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
  prefsPage: { paddingHorizontal: S.xl, paddingTop: S.xl, paddingBottom: S.xxl, gap: S.lg },
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: S.lg, paddingHorizontal: S.xl },
  extPage: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: S.lg, paddingHorizontal: S.xl, paddingVertical: S.xl },
  badge: { width: 104, height: 104, borderRadius: 32, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', marginBottom: S.md },
  badgeSmall: { width: 80, height: 80, borderRadius: 24, marginBottom: 0 },
  bottom: { paddingHorizontal: S.lg, gap: S.lg },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.borderStrong },
  dotOn: { width: 22, backgroundColor: C.accentText },
});
