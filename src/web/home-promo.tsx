// Home page, right under the hero: the two things Huwa Web pushes first, side by side from 768 px.
// · "L'app Android": everywhere but iPhone / iPad (no native app there yet). On Android the
//   button starts the APK download and keeps the how-to on screen; elsewhere it opens the APK
//   guide with a QR code for the phone (./install.tsx).
// · "Le Discord Huwa": whenever the instance has an invite (/huwa-config.json community.discord).
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { openDiscord } from '@/components/discord-invite';
import { useDiscordInvite } from '@/community/invite';
import { Button, Txt } from '@/components/ui';
import { C, R, S, SHADOW } from '@/theme/tokens';

import { useWebConfig } from './config';
import { download, InstallDialog, useApk, useInstallSuggestion } from './install';
import { WIDE, useWindowSize } from './viewport';

const DISCORD = '#5865F2';
const ANDROID = '#3DDC84';

type IconName = keyof typeof Ionicons.glyphMap;

export function HomePromo({ pad }: { pad: number }) {
  const invite = useDiscordInvite();
  const { features } = useWebConfig();
  const suggestion = useInstallSuggestion();
  const { width } = useWindowSize();
  const [guide, setGuide] = useState(false);
  const onAndroid = suggestion.kind === 'android-apk';
  const apk = useApk(onAndroid);
  // iPhone / iPad: no Android card (the install banner offers the home screen there).
  const ios = suggestion.kind === 'ios-home-screen';
  const android = features.install && !ios;
  if (!android && !invite) return null;
  const wide = width >= WIDE;

  return (
    <View role="region" aria-label="L’app Android et la communauté" style={[styles.row, { paddingHorizontal: pad, flexDirection: wide ? 'row' : 'column' }]}>
      {android && (
        <Card
          icon="logo-android"
          tint={ANDROID}
          iconColor="#05210F"
          title="L’app Android"
          body="Lecteur natif, téléchargements hors ligne, notifications de sorties. Gratuite et open source."
          action={onAndroid ? `Télécharger l’APK${apk.version ? ` (${apk.version})` : ''}` : 'Installer sur Android'}
          actionIcon="download-outline"
          onPress={() => {
            if (onAndroid) download(apk);
            setGuide(true);
          }}
        />
      )}
      {invite && (
        <Card
          icon="logo-discord"
          tint={DISCORD}
          iconColor="#FFFFFF"
          title="Le Discord Huwa"
          body="De l’aide, les nouveautés en avant-première, tes suggestions et un coin pour partager tes packs."
          action="Rejoindre le Discord"
          actionIcon="open-outline"
          onPress={() => void openDiscord(invite)}
        />
      )}
      <InstallDialog visible={guide} onClose={() => setGuide(false)} android />
    </View>
  );
}

function Card({
  icon,
  tint,
  iconColor,
  title,
  body,
  action,
  actionIcon,
  onPress,
}: {
  icon: IconName;
  tint: string;
  iconColor: string;
  title: string;
  body: string;
  action: string;
  actionIcon: IconName;
  onPress: () => void;
}) {
  return (
    <View style={[styles.card, { borderColor: `${tint}55` }]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: `${tint}14` }]} pointerEvents="none" />
      <View style={styles.head}>
        <View style={[styles.badge, { backgroundColor: tint }]}>
          <Ionicons name={icon} size={24} color={iconColor} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="headline">{title}</Txt>
          <Txt v="small" color={C.body}>{body}</Txt>
        </View>
      </View>
      <Button label={action} icon={actionIcon} onPress={onPress} style={{ alignSelf: 'stretch' }} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: S.md, marginTop: S.lg },
  card: {
    flex: 1, gap: S.md, padding: S.lg, overflow: 'hidden',
    borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1,
    boxShadow: `${SHADOW.raised}, ${SHADOW.inset}`,
  },
  head: { flexDirection: 'row', gap: S.md, alignItems: 'flex-start' },
  badge: { width: 44, height: 44, borderRadius: 14, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', boxShadow: SHADOW.insetStrong },
});
