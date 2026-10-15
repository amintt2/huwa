// "Rejoins la communauté Huwa sur Discord": one-time card right after onboarding (native and web),
// and the Réglages row. Logic and configuration: src/community/discord.ts.
//
// A floating card rather than a modal: it never fights the sheets that also follow onboarding
// (passkey offer on the phone, phrase backup on the web) and simply waits underneath them.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { Linking, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { finishDiscordInvite, useDiscordInvitePending } from '@/community/discord';
import { useDiscordInvite } from '@/community/invite';
import { Row } from '@/components/social';
import { Button, Txt } from '@/components/ui';
import { C, R, S, SHADOW } from '@/theme/tokens';

const DISCORD = '#5865F2';
const SHOW_AFTER_MS = 1200;

export const openDiscord = (url: string) => Linking.openURL(url).catch(() => {});

/**
 * Mounted by the root layouts while signed in. `blocked`: another post-onboarding step is on
 * screen (web phrase backup), wait for it.
 */
export function DiscordInviteCard({ blocked = false }: { blocked?: boolean }) {
  const invite = useDiscordInvite();
  const pending = useDiscordInvitePending();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [shown, setShown] = useState(false);
  const want = !!invite && pending && !blocked;
  useEffect(() => {
    if (!want) return;
    const t = setTimeout(() => setShown(true), SHOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [want]);
  if (!invite || !pending || !shown) return null;
  const wide = width >= 768;
  const close = () => finishDiscordInvite();
  return (
    <Animated.View
      entering={FadeInDown.duration(260)}
      exiting={FadeOutDown.duration(180)}
      role="region"
      aria-label="Communauté Huwa sur Discord"
      accessibilityLiveRegion="polite"
      style={[styles.card, wide ? { right: S.xl, bottom: S.xl, width: 400 } : { left: S.md, right: S.md, bottom: insets.bottom + 72 }]}>
      <View style={styles.head}>
        <View style={styles.badge}>
          <Ionicons name="logo-discord" size={22} color="#fff" />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="headline">Rejoins la communauté Huwa sur Discord</Txt>
          <Txt v="small" color={C.body}>De l’aide, les nouveautés en avant-première, et un coin pour partager tes packs.</Txt>
        </View>
      </View>
      <View style={styles.actions}>
        <Button small variant="ghost" label="Plus tard" onPress={close} style={{ flex: 1 }} />
        <Button
          small
          label="Rejoindre"
          icon="open-outline"
          iconRight
          onPress={() => {
            void openDiscord(invite);
            close();
          }}
          style={{ flex: 1 }}
          accessibilityHint="Ouvre l’invitation Discord"
        />
      </View>
    </Animated.View>
  );
}

/** Réglages → "Communauté Discord" (nothing when no invite is configured). */
export function DiscordRow({ last = true }: { last?: boolean }) {
  const invite = useDiscordInvite();
  if (!invite) return null;
  return (
    <Row
      icon="logo-discord"
      iconColor={DISCORD}
      label="Communauté Discord"
      detail="Aide, nouveautés, partage de packs"
      external
      onPress={() => void openDiscord(invite)}
      last={last}
    />
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute', zIndex: 60, padding: S.lg, gap: S.md,
    borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.elevated, borderWidth: 1, borderColor: C.borderStrong,
    boxShadow: `${SHADOW.float}, ${SHADOW.inset}`,
  },
  head: { flexDirection: 'row', gap: S.md, alignItems: 'flex-start' },
  badge: {
    width: 44, height: 44, borderRadius: 14, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center',
    backgroundColor: DISCORD, boxShadow: SHADOW.insetStrong,
  },
  actions: { flexDirection: 'row', gap: S.sm },
});
