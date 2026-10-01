// Réglages → « À propos » : version / build, terms, privacy, support contact and the licences of
// the open-source components the app ships (including mpv / FFmpeg under the LGPL).
import * as Application from 'expo-application';
import * as WebBrowser from 'expo-web-browser';
import { Alert } from 'react-native';

import { deviceCaps } from '@/components/player/engines/hybrid-player';
import { Group, Row } from '@/components/social';
import { Screen } from '@/components/screen';
import { Txt } from '@/components/ui';
import { channel } from '@/config/channel';
import { mailSupport, PRIVACY_URL, SOURCE_URL, SUPPORT_EMAIL, TERMS_URL } from '@/config/legal';

const MPV_SOURCES = 'https://github.com/mpvkit/MPVKit';

const LICENCES: { name: string; licence: string; url: string }[] = [
  { name: 'React Native', licence: 'MIT', url: 'https://github.com/facebook/react-native' },
  { name: 'Expo', licence: 'MIT', url: 'https://github.com/expo/expo' },
  { name: 'Bare, react-native-bare-kit', licence: 'Apache-2.0', url: 'https://github.com/holepunchto/react-native-bare-kit' },
  { name: 'Hypercore, Hyperswarm, Corestore, Hyperbee', licence: 'MIT', url: 'https://github.com/holepunchto' },
  { name: 'Autobase', licence: 'Apache-2.0', url: 'https://github.com/holepunchto/autobase' },
  { name: 'noble-curves, scure-bip39', licence: 'MIT', url: 'https://github.com/paulmillr' },
  { name: 'fflate', licence: 'MIT', url: 'https://github.com/101arrowz/fflate' },
  { name: 'Polices Google Fonts', licence: 'SIL OFL 1.1', url: 'https://github.com/expo/google-fonts' },
];

const open = (url: string) => WebBrowser.openBrowserAsync(url).catch(() => {});

export default function About() {
  const version = Application.nativeApplicationVersion ?? '—';
  const build = Application.nativeBuildVersion ?? '—';
  const { mpvAvailable } = deviceCaps();
  const contact = () =>
    mailSupport('Huwa — contact', `\n\n—\nHuwa ${version} (${build}) · ${channel === 'store' ? 'App Store' : 'version complète'}`).then((ok) => {
      if (!ok) Alert.alert('Aucune app Mail', `Écris-nous à ${SUPPORT_EMAIL}.`);
    });

  return (
    <Screen title="À propos">
        <Group>
          <Row icon="information-circle-outline" label="Version" detail={`${version} (build ${build}) · ${channel === 'store' ? 'App Store' : 'version complète'}`} last />
        </Group>

        <Group title="Conditions et confidentialité">
          <Row icon="document-text-outline" label="Conditions d’utilisation" detail="CGU / contrat de licence (EULA)" onPress={() => open(TERMS_URL)} />
          <Row icon="lock-closed-outline" label="Confidentialité" detail="Ce que Huwa garde, ce qui passe de pair à pair" onPress={() => open(PRIVACY_URL)} last />
        </Group>

        <Group title="Aide" footer="Un humain lit chaque message, y compris les signalements de comptes ou de contenus.">
          <Row icon="mail-outline" label="Contacter le support" detail={SUPPORT_EMAIL} onPress={contact} last />
        </Group>

        <Group title="Licences" footer="Huwa est construit avec ces logiciels libres ; leurs licences complètes sont sur les pages des projets.">
          {mpvAvailable && (
            <Row
              icon="film-outline"
              label="mpv (libmpv) et FFmpeg · LGPL"
              detail="Liés dynamiquement (Libmpv.framework, remplaçable). Sources et licences"
              onPress={() => open(MPV_SOURCES)}
            />
          )}
          {LICENCES.map((l, i) => (
            <Row key={l.name} label={l.name} detail={l.licence} onPress={() => open(l.url)} last={i === LICENCES.length - 1} />
          ))}
        </Group>

        <Group>
          <Row icon="logo-github" label="Code source de Huwa" onPress={() => open(SOURCE_URL)} last />
        </Group>

        <Txt v="small" style={{ textAlign: 'center', lineHeight: 18 }}>
          Huwa ne fournit aucun contenu : catalogue AniList, vidéos et chapitres viennent des services et extensions que tu choisis.
        </Txt>
      </Screen>
  );
}
