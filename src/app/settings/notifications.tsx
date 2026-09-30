import Ionicons from '@expo/vector-icons/Ionicons';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Group, OptionRow, ScreenHeader, SwitchRow } from '@/components/social';
import { Txt } from '@/components/ui';
import { setPrefs, usePrefs } from '@/p2p/prefs';
import { C, R, S } from '@/theme/tokens';

/** Push relay infrastructure is not wired yet: "Instantané" stays visible but disabled. */
const PUSH_RELAY_AVAILABLE = false;

export default function NotificationSettings() {
  const insets = useSafeAreaInsets();
  const mode = usePrefs((p) => p.dmNotif);
  const requests = usePrefs((p) => p.dmRequests);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <ScreenHeader title="Notifications" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: S.lg, paddingBottom: insets.bottom + S.xxl, gap: S.xl }}>
        <Group title="Nouveaux messages privés">
          <OptionRow
            label="Discret"
            note="PAR DÉFAUT"
            selected={mode === 'discreet'}
            onPress={() => setPrefs((p) => ({ ...p, dmNotif: 'discreet' }))}
            detail="Ton téléphone vérifie de temps en temps s’il y a du nouveau (toutes les 15 min environ, quand le système le permet) et t’affiche une notification locale. Aucun service tiers n’est contacté. Les messages peuvent arriver avec un peu de retard."
          />
          <OptionRow
            label="Instantané"
            note={PUSH_RELAY_AVAILABLE ? undefined : 'NÉCESSITE UN RELAIS PUSH'}
            selected={mode === 'instant'}
            disabled={!PUSH_RELAY_AVAILABLE}
            onPress={() => setPrefs((p) => ({ ...p, dmNotif: 'instant' }))}
            detail="Un relais transmet un simple « ping » chiffré à Apple ou Google dès qu’un message t’attend. Il ne voit ni le contenu ni l’expéditeur, seulement ton jeton d’appareil, ton adresse IP et la fréquence des pings."
            last
          />
        </Group>

        <View style={styles.info}>
          <Ionicons name="lock-closed-outline" size={18} color={C.accentText} />
          <Txt v="small" style={{ flex: 1, lineHeight: 18 }}>
            Dans les deux cas, le texte de tes messages reste chiffré de bout en bout. La notification affiche seulement « Nouveau message » ; le contenu se synchronise à l’ouverture de l’app.
          </Txt>
        </View>

        <Group footer="Désactivé : seules les personnes que tu suis peuvent t’écrire.">
          <SwitchRow
            icon="mail-unread-outline"
            label="Demandes de message"
            detail="Recevoir les messages de personnes que tu ne suis pas"
            value={requests}
            onChange={(v) => setPrefs((p) => ({ ...p, dmRequests: v }))}
            last
          />
        </Group>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  info: { flexDirection: 'row', gap: S.md, padding: S.md, borderRadius: R.card, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
});
