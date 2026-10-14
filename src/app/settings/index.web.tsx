// Web Réglages: public (the streaming server is chosen before signing in, as on Stremio Web), with
// the account sections once signed in. Native sub-pages (Général, Sous-titres, Sécurité…) are the
// same as on the phone.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Screen } from '@/components/screen';
import { Group, Row, WARN } from '@/components/social';
import { Txt } from '@/components/ui';
import { useMe, useSecurity } from '@/p2p/hooks';
import { langName } from '@/subtitles/lang';
import { useSubtitlePrefs } from '@/subtitles/prefs';
import { useSettings } from '@/settings/settings';
import { C, S } from '@/theme/tokens';
import { useWebConfig } from '@/web/config';
import { isIOS, isStandalone, promptInstall, useCanInstall } from '@/web/pwa';
import { SignInActions } from '@/web/sign-in';
import { StreamingServerSettings } from '@/web/streaming-settings';
import { WebSessionCard } from '@/components/web-login';

export default function WebSettings() {
  const me = useMe();
  const config = useWebConfig();
  return (
    <Screen title="Réglages" onBack={() => (router.canGoBack() ? router.back() : router.navigate('/'))} contentContainerStyle={{ width: '100%', maxWidth: 760, alignSelf: 'center' }} gap={S.xl}>
      <StreamingServerSettings />
      {me ? <AccountGroups /> : (
        <Group title="Compte" footer="Ton compte est une clé gardée dans ce navigateur. Une session par navigateur.">
          <View style={{ padding: S.lg, gap: S.md }}>
            <Txt v="body" color={C.body}>Connecte-toi pour lire, commenter et retrouver tes extensions.</Txt>
            <SignInActions />
          </View>
        </Group>
      )}
      <AppGroup />
      <Group title="Instance" footer={config.source === 'defaults' ? 'Aucun fichier /huwa-config.json : réglages par défaut.' : undefined}>
        <Row icon="globe-outline" label={config.instanceName} detail={typeof location === 'undefined' ? undefined : location.host} />
        {config.operatorContact && (
          <Row icon="mail-outline" label="Contacter l’opérateur" external onPress={() => window.open(config.operatorContact!, '_blank', 'noopener')} />
        )}
        <Row icon="information-circle-outline" label="À propos" detail="Version, conditions, confidentialité, licences" onPress={() => router.push('/about')} last />
      </Group>
    </Screen>
  );
}

function AccountGroups() {
  const { state } = useSecurity();
  const subPrefs = useSubtitlePrefs();
  const { subLangs } = useSettings();
  return (
    <>
      <Group title="Compte">
        <Row icon="person-circle-outline" label="Modifier le profil" onPress={() => router.push('/profile-edit')} />
        <Row
          icon={state && !state.phraseVerified ? 'warning-outline' : 'shield-checkmark-outline'}
          iconColor={state && !state.phraseVerified ? WARN : C.accentText}
          label="Sécurité et sauvegarde"
          detail={state ? (state.phraseVerified ? 'Phrase vérifiée' : 'Phrase de récupération non vérifiée') : undefined}
          onPress={() => router.push('/settings/security')}
          last
        />
      </Group>
      {/* This browser's session: lock with a passkey, public computer mode, log out (revokes it). */}
      <WebSessionCard />
      <Group title="Lecture">
        <Row icon="options-outline" label="Général" detail="Langue, lecture, données" onPress={() => router.push('/settings/general')} />
        <Row icon="text" label="Sous-titres" detail={subPrefs.enabled ? subLangs.map(langName).join(', ') : 'Désactivés'} onPress={() => router.push('/settings/subtitles')} />
        <Row icon="extension-puzzle-outline" label="Extensions" onPress={() => router.push('/addons')} />
        <Row icon="shield-half-outline" label="Modération" onPress={() => router.push('/settings/moderation')} last />
      </Group>
    </>
  );
}

function AppGroup() {
  const canInstall = useCanInstall();
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => {
    navigator.storage?.persisted?.().then(setPersisted, () => setPersisted(null));
  }, []);
  const standalone = isStandalone();
  return (
    <Group title="Application">
      {standalone ? (
        <Row icon="phone-portrait-outline" label="App installée" detail="Huwa tourne dans sa propre fenêtre." />
      ) : canInstall ? (
        <Row icon="download-outline" label="Installer l’app" detail="Une fenêtre à part, l’accueil hors ligne, une icône." onPress={() => void promptInstall()} />
      ) : (
        <Row
          icon="download-outline"
          label="Installer l’app"
          detail={isIOS() ? 'Dans Safari : Partager → Sur l’écran d’accueil.' : 'Menu du navigateur → Installer Huwa (Chrome, Edge) ou Ajouter à l’écran d’accueil.'}
        />
      )}
      <Row
        icon="save-outline"
        label="Stockage persistant"
        detail={persisted ? 'Accordé : le navigateur ne videra pas tes données.' : 'Pas encore accordé : le navigateur peut vider les données s’il manque de place.'}
        last
      />
    </Group>
  );
}
