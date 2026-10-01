// Onboarding choice for "Comparer avec la communauté" (src/stats/share.ts): opt-in, off by default,
// changeable later in Réglages → Lecture → Statistiques de lecture.
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, View } from 'react-native';

import { setCommunity, useStats } from '@/stats/store';
import { C, R, S } from '@/theme/tokens';

import { Press, Txt, type IconName } from './ui';

function Option({ on, label, hint, onPress }: { on: boolean; label: string; hint: string; onPress: () => void }) {
  return (
    <Press onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected: on }} style={[styles.option, on && styles.optionOn]}>
      <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={20} color={on ? C.accentText : C.text2} />
      <View style={{ flex: 1, gap: 1 }}>
        <Txt v="label">{label}</Txt>
        <Txt v="small">{hint}</Txt>
      </View>
    </Press>
  );
}

function Point({ icon, color, children }: { icon: IconName; color: string; children: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: S.sm, alignItems: 'flex-start' }}>
      <Ionicons name={icon} size={16} color={color} style={{ marginTop: 2 }} />
      <Txt v="small" style={{ flex: 1, lineHeight: 19 }}>{children}</Txt>
    </View>
  );
}

export function StatsOptIn() {
  const on = useStats((s) => s.community);
  return (
    <View style={{ gap: S.lg, alignSelf: 'stretch' }}>
      <View style={{ gap: S.sm }}>
        <Option on={!on} label="Non merci" hint="Tes mesures restent sur ton téléphone, rien n’est partagé." onPress={() => setCommunity(false)} />
        <Option on={on} label="Oui, partager anonymement" hint="Et voir ton temps de démarrage face à celui de la communauté." onPress={() => setCommunity(true)} />
      </View>
      <View style={styles.card}>
        <Point icon="checkmark-circle-outline" color={C.success}>Au plus une fois par semaine : combien de démarrages ont pris moins de 0,5 s, 1 s, 2 s… par type de source, avec un bruit aléatoire.</Point>
        <Point icon="close-circle-outline" color={C.text2}>Jamais de titre, de lien, d’extension ni d’identité : chaque envoi part d’une clé jetable.</Point>
        <Point icon="alert-circle-outline" color="#F5B544">Comme toute connexion pair-à-pair, ton adresse IP est visible des pairs connectés à ce moment-là.</Point>
      </View>
      <Txt v="small">Tu pourras changer d’avis dans Réglages → Lecture → Statistiques de lecture.</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  option: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  optionOn: { borderColor: C.accentLine, backgroundColor: C.accentSoft },
  card: { gap: S.sm, padding: S.md, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
});
