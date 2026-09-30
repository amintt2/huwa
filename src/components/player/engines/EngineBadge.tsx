// Discreet "mpv" marker shown in the sources menu when the fallback engine plays the video.
import { StyleSheet, Text, View } from 'react-native';

import { Txt } from '@/components/ui';
import { C, F, R, S } from '@/theme/tokens';

import { useActiveEngine } from './prefs';

/** `pill`: just the tag. `row`: tag + why and how ("conteneur MKV · HEVC · décodage matériel"). */
export function EngineBadge({ variant = 'pill' }: { variant?: 'pill' | 'row' }) {
  const active = useActiveEngine();
  if (active?.engine !== 'mpv') return null;
  const pill = (
    <View style={styles.pill} accessibilityLabel="Lecteur de secours mpv">
      <Text style={styles.pillText}>mpv</Text>
    </View>
  );
  if (variant === 'pill') return pill;
  const info = [active.reason, active.detail].filter(Boolean).join(' · ');
  return (
    <View style={styles.row}>
      {pill}
      <Txt v="small" numberOfLines={2} style={{ flex: 1 }}>
        Lecteur de secours{info ? ` — ${info}` : ''}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 6, paddingVertical: 1, borderRadius: R.pill,
    borderWidth: StyleSheet.hairlineWidth, borderColor: C.accentLine, backgroundColor: C.accentSoft,
  },
  pillText: { color: C.accentText, fontSize: 10, letterSpacing: 0.3, ...F.bold },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
});
