// Overlays shared by the native player and the web player: skip / next pills and the
// "Épisode suivant" countdown card.
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Txt, type IconName } from '@/components/ui';
import { C, F, R, S } from '@/theme/tokens';

export const AUTO_NEXT_SECONDS = 10;

export function Pill({ icon, label, onPress, primary }: { icon: IconName; label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [overlay.pill, primary && overlay.pillPrimary, pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] }]}>
      <Text style={overlay.pillText}>{label}</Text>
      <Ionicons name={icon} size={15} color={C.white} />
    </Pressable>
  );
}

/** "Épisode suivant dans N s" card with Annuler / Lire maintenant. */
export function NextCard({ label, countdown, onCancel, onPlay, style }: {
  label: string;
  countdown: number;
  onCancel: () => void;
  onPlay: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[overlay.nextCard, style]}>
      <Txt v="caption" color={C.accentText} tabular>Épisode suivant dans {countdown} s</Txt>
      <Txt v="label" numberOfLines={1}>{label}</Txt>
      <View style={overlay.countTrack}>
        <View style={[overlay.countFill, { width: `${(1 - countdown / AUTO_NEXT_SECONDS) * 100}%` }]} />
      </View>
      <View style={{ flexDirection: 'row', gap: S.sm }}>
        <Pressable style={({ pressed }) => [overlay.cardBtn, { backgroundColor: 'rgba(255,255,255,0.12)' }, pressed && { opacity: 0.7 }]} onPress={onCancel} accessibilityRole="button">
          <Text style={overlay.pillText}>Annuler</Text>
        </Pressable>
        <Pressable style={({ pressed }) => [overlay.cardBtn, { backgroundColor: C.accent, flex: 1 }, pressed && { opacity: 0.85 }]} onPress={onPlay} accessibilityRole="button">
          <Ionicons name="play" size={14} color={C.white} />
          <Text style={overlay.pillText}>Lire maintenant</Text>
        </Pressable>
      </View>
    </View>
  );
}

export const overlay = StyleSheet.create({
  /** Glass pill over the video ("Passer l'opening", "Épisode suivant"). */
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 18,
    borderRadius: R.control, borderCurve: 'continuous', backgroundColor: 'rgba(16,21,34,0.78)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)', boxShadow: '0px 6px 20px -6px rgba(0,0,0,0.6)',
  },
  pillPrimary: { backgroundColor: C.accent, borderColor: 'rgba(255,255,255,0.18)' },
  pillText: { color: C.white, fontSize: 14, ...F.bold, letterSpacing: -0.1 },
  nextCard: {
    position: 'absolute', width: 300, gap: 8, padding: S.md,
    borderRadius: R.card, borderCurve: 'continuous', backgroundColor: 'rgba(12,17,28,0.94)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
    boxShadow: '0px 12px 32px -8px rgba(0,0,0,0.7)',
  },
  countTrack: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.14)', overflow: 'hidden' },
  countFill: { height: 3, backgroundColor: C.accentText },
  cardBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 40, paddingHorizontal: 14,
    borderRadius: R.control, borderCurve: 'continuous', marginTop: 4,
  },
});
