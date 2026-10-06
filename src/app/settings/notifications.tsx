
import { Group, OptionRow, SwitchRow } from '@/components/social';
import { Screen } from '@/components/screen';
import { Callout } from '@/components/feedback';
import { setPrefs, usePrefs } from '@/p2p/prefs';

/** Push relay infrastructure is not wired yet: "Instantané" stays visible but disabled. */
const PUSH_RELAY_AVAILABLE = false;

export default function NotificationSettings() {
  const mode = usePrefs((p) => p.dmNotif);
  const requests = usePrefs((p) => p.dmRequests);

  return (
    <Screen title="Notifications">
        <Group title="Nouveaux messages privés">
          <OptionRow
            label="Discret"
            note="Par défaut"
            selected={mode === 'discreet'}
            onPress={() => setPrefs((p) => ({ ...p, dmNotif: 'discreet' }))}
            detail="Ton téléphone vérifie de temps en temps s’il y a du nouveau (toutes les 15 min environ, quand le système le permet) et t’affiche une notification locale. Aucun service tiers n’est contacté. Les messages peuvent arriver avec un peu de retard."
          />
          <OptionRow
            label="Instantané"
            note={PUSH_RELAY_AVAILABLE ? undefined : 'Relais push requis'}
            selected={mode === 'instant'}
            disabled={!PUSH_RELAY_AVAILABLE}
            onPress={() => setPrefs((p) => ({ ...p, dmNotif: 'instant' }))}
            detail="Un relais transmet un simple « ping » chiffré à Apple ou Google dès qu’un message t’attend. Il ne voit ni le contenu ni l’expéditeur, seulement ton jeton d’appareil, ton adresse IP et la fréquence des pings."
            last
          />
        </Group>

        <Callout icon="lock-closed-outline">
          Dans les deux cas, le texte de tes messages reste chiffré de bout en bout. La notification affiche seulement « Nouveau message » ; le contenu se synchronise à l’ouverture de l’app.
        </Callout>

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
      </Screen>
  );
}
