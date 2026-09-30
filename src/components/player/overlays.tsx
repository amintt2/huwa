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
      style={({ pressed }) => [overlay.pill, primary && { backgroundColor: C.accent }, pressed && { opacity: 0.8 }]}>
      <Ionicons name={icon} size={14} color={primary ? C.white : C.bg} />
      <Text style={[overlay.pillText, primary && { color: C.white }]}>{label}</Text>
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
      <Txt v="caption" color={C.accentText}>ÉPISODE SUIVANT DANS {countdown} S</Txt>
      <Txt v="label" numberOfLines={1}>{label}</Txt>
      <View style={overlay.countTrack}>
        <View style={[overlay.countFill, { width: `${(1 - countdown / AUTO_NEXT_SECONDS) * 100}%` }]} />
      </View>
      <View style={{ flexDirection: 'row', gap: S.sm }}>
        <Pressable style={[overlay.cardBtn, { backgroundColor: C.elevated }]} onPress={onCancel} accessibilityRole="button">
          <Text style={[overlay.pillText, { color: C.text }]}>Annuler</Text>
        </Pressable>
        <Pressable style={[overlay.cardBtn, { backgroundColor: C.accent }]} onPress={onPlay} accessibilityRole="button">
          <Ionicons name="play" size={14} color={C.white} />
          <Text style={[overlay.pillText, { color: C.white }]}>Lire maintenant</Text>
        </Pressable>
      </View>
    </View>
  );
}

export const overlay = StyleSheet.create({
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 9, paddingHorizontal: 14,
    borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.white,
  },
  pillText: { color: C.bg, fontSize: 13, ...F.bold },
  nextCard: {
    position: 'absolute', maxWidth: 320, gap: 6, padding: S.md,
    borderRadius: R.card, borderCurve: 'continuous', backgroundColor: 'rgba(12,17,28,0.94)', borderWidth: 1, borderColor: C.border,
  },
  countTrack: { height: 3, borderRadius: 2, backgroundColor: C.elevated, overflow: 'hidden' },
  countFill: { height: 3, backgroundColor: C.accent },
  cardBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12,
    borderRadius: R.control, borderCurve: 'continuous', marginTop: 4,
  },
});
