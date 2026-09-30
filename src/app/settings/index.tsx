import { router } from 'expo-router';
import { Alert, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Group, Row, ScreenHeader, WARN } from '@/components/social';
import { Txt } from '@/components/ui';
import { useAddons } from '@/addons/registry';
import { useP2PStatus, useSecurity } from '@/p2p/hooks';
import { usePrefs } from '@/p2p/prefs';
import { resetAll } from '@/store/store';
import { C, S } from '@/theme/tokens';

export default function Settings() {
  const insets = useSafeAreaInsets();
  const status = useP2PStatus();
  const { state } = useSecurity();
  const dmNotif = usePrefs((p) => p.dmNotif);
  const lists = usePrefs((p) => p.subscriptions.length);
  const words = usePrefs((p) => p.words.length);
  const addonCount = useAddons().filter((a) => a.enabled).length;

  const network =
    status.state === 'ready' && status.peers === 0
      ? 'Mode local : tout fonctionne sur cet appareil, aucun pair connecté.'
      : status.state === 'ready'
        ? `${status.peers} pair${status.peers > 1 ? 's' : ''} connecté${status.peers > 1 ? 's' : ''}.`
        : status.state === 'offline'
          ? 'Hors ligne : tes actions partiront à la reconnexion.'
          : status.state === 'error'
            ? `Réseau indisponible${status.error ? ` (${status.error})` : ''}.`
            : 'Démarrage…';

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <ScreenHeader title="Réglages" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: S.lg, paddingBottom: insets.bottom + S.xxl, gap: S.xl }}>
        <Group title="Compte">
          <Row icon="person-circle-outline" label="Modifier le profil" onPress={() => router.push('/profile-edit')} />
          <Row
            icon={state && !state.phraseVerified ? 'warning-outline' : 'shield-checkmark-outline'}
            iconColor={state && !state.phraseVerified ? WARN : C.accentText}
            label="Sécurité et sauvegarde"
            detail={state ? (state.phraseVerified ? `Phrase vérifiée · ${state.devices} appareil${state.devices > 1 ? 's' : ''}` : 'Phrase de récupération non vérifiée') : undefined}
            onPress={() => router.push('/settings/security')}
            last
          />
        </Group>

        <Group title="Communauté">
          <Row
            icon="shield-half-outline"
            label="Modération"
            detail={`${lists} liste${lists > 1 ? 's' : ''} de blocage · ${words} mot${words > 1 ? 's' : ''} masqué${words > 1 ? 's' : ''}`}
            onPress={() => router.push('/settings/moderation')}
          />
          <Row
            icon="notifications-outline"
            label="Notifications des messages"
            detail={dmNotif === 'discreet' ? 'Discret' : 'Instantané'}
            onPress={() => router.push('/settings/notifications')}
            last
          />
        </Group>

        <Group title="Lecture">
          <Row icon="extension-puzzle-outline" label="Addons" detail={`${addonCount} actif${addonCount > 1 ? 's' : ''}`} onPress={() => router.push('/addons')} />
          <Row
            icon="refresh"
            label="Réinitialiser la progression"
            destructive
            chevron={false}
            last
            onPress={() =>
              Alert.alert(
                'Réinitialiser la progression ?',
                'Épisodes vus, chapitres lus et ta liste seront effacés de cet appareil. Ton identité, tes commentaires publiés et ton rang sont conservés.',
                [
                  { text: 'Annuler', style: 'cancel' },
                  { text: 'Réinitialiser', style: 'destructive', onPress: resetAll },
                ],
              )
            }
          />
        </Group>

        <Group title="Réseau" footer="Huwa n’a pas de serveur : ton compte et tes données vivent sur tes appareils et chez les pairs que tu rejoins.">
          <Row icon="git-network-outline" label={status.state === 'ready' ? 'Connecté' : 'Réseau'} detail={network} last />
        </Group>

        <Txt v="small" style={{ textAlign: 'center' }}>Huwa · données locales, sans télémétrie</Txt>
      </ScrollView>
    </View>
  );
}
