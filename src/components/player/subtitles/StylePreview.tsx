// Live preview of the subtitle style over a sample picture (bright or night scene): the bright
// one is the hard case for white text, where outline and shadow matter.
import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { FilterChip } from '@/components/states';
import { parseSrt } from '@/subtitles/text';
import type { SubtitlePrefs } from '@/subtitles/prefs';
import { C, R, S } from '@/theme/tokens';

import { SubtitleOverlay } from './SubtitleOverlay';

const SAMPLE = parseSrt('1\n00:00:00,000 --> 99:00:00,000\n<i>Tu entends ça ?</i> Le vent chante,\nce soir. « Hoshizora » — 星空\n');

const SCENES = {
  day: { sky: ['#5FA8F5', '#BFE0FF', '#FFE7C2'] as const, far: '#9CC7A4', near: '#F3EAD8', sun: '#FFF6D6' },
  night: { sky: ['#070B1E', '#1B2250', '#3A2D5C'] as const, far: '#141A36', near: '#262B45', sun: '#F4F1E6' },
};

export function StylePreview({ prefs }: { prefs?: SubtitlePrefs }) {
  const [scene, setScene] = useState<keyof typeof SCENES>('day');
  const s = SCENES[scene];
  return (
    <View style={{ gap: S.sm }}>
      <View style={styles.frame} accessibilityLabel="Aperçu des sous-titres" accessibilityRole="image">
        <LinearGradient colors={s.sky} style={StyleSheet.absoluteFill} />
        <View style={[styles.sun, { backgroundColor: s.sun }]} />
        <View style={[styles.hill, { backgroundColor: s.far, left: '-20%', width: '90%', bottom: '18%' }]} />
        <View style={[styles.hill, { backgroundColor: s.far, right: '-25%', width: '80%', bottom: '14%', opacity: 0.85 }]} />
        <View style={[styles.ground, { backgroundColor: s.near }]} />
        <SubtitleOverlay doc={SAMPLE} time={1} playing={false} prefs={prefs} />
      </View>
      <View style={{ flexDirection: 'row', gap: S.sm }}>
        <FilterChip icon="sunny-outline" label="Scène claire" selected={scene === 'day'} onPress={() => setScene('day')} />
        <FilterChip icon="moon-outline" label="Nuit" selected={scene === 'night'} onPress={() => setScene('night')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { width: '100%', aspectRatio: 16 / 9, borderRadius: R.card, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: C.black },
  sun: { position: 'absolute', top: '14%', right: '18%', width: '13%', aspectRatio: 1, borderRadius: 999, opacity: 0.95 },
  hill: { position: 'absolute', aspectRatio: 2.4, borderTopLeftRadius: 999, borderTopRightRadius: 999 },
  ground: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '30%' },
});
