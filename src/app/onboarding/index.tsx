import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CloudAccountCard } from '@/components/cloud-account';
import { DANGER } from '@/components/social';
import { Button, Txt, Wordmark, type IconName } from '@/components/ui';
import { social } from '@/p2p/hooks';
import { getState } from '@/store/store';
import { C, F, S, SHADOW } from '@/theme/tokens';

// First screen after the introduction: one button. No pseudo, no key, no phrase, no QR code here:
// the identity is created quietly with a temporary pseudo (changeable in the profile), and its
// backup goes to iCloud Keychain on its own. Saving the phrase, linking a device and the technical
// details live in Réglages → Compte et appareils.
const POINTS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'swap-horizontal', title: 'Anime et manhwa reliés', text: 'Reprends le manhwa là où l’anime s’arrête, et inversement.' },
  { icon: 'calendar-outline', title: 'Ta liste et tes sorties', text: 'Tes séries, tes listes et le calendrier des nouveaux épisodes.' },
  { icon: 'lock-closed-outline', title: 'Sans email ni mot de passe', text: 'Ton compte est créé sur ce téléphone et sauvegardé dans ton iCloud.' },
];

/** Temporary pseudo until the user picks one (profile). */
const tempName = () => `fan-${Math.floor(1000 + Math.random() * 9000)}`;

export default function Welcome() {
  const insets = useSafeAreaInsets();
  const legacy = getState().userName;
  const name = legacy && legacy !== 'moi' && legacy.trim().length >= 2 ? legacy : tempName();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // An iCloud account card takes the primary role: creating a new identity steps back.
  const [cloudCard, setCloudCard] = useState(false);
  // An account phrase found in iCloud Keychain: creating a new identity replaces that copy on every
  // Apple device (cloud-backup save), so say it before doing it.
  const [cloudAccount, setCloudAccount] = useState<{ name?: string }>();

  const create = () => {
    if (busy) return;
    if (!cloudAccount) return void doCreate();
    const who = cloudAccount.name ? `le compte « ${cloudAccount.name} »` : 'un compte Huwa';
    Alert.alert(
      'Remplacer la sauvegarde iCloud ?',
      `Ton iCloud contient déjà ${who}. Commencer avec un nouveau compte remplacera cette sauvegarde sur tous tes appareils Apple : l’ancien compte pourrait être perdu.`,
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Créer quand même', style: 'destructive', onPress: () => void doCreate() },
      ],
    );
  };

  const doCreate = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // No passkey sheet right after « Commencer »: the iCloud Keychain backup is enough to start;
      // passkeys are offered in Réglages → Compte et appareils.
      await social.createIdentity(name);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // The protected stack now switches to the app on its own.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Impossible de démarrer. Réessaie.');
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1, paddingTop: insets.top + S.xxl, paddingBottom: insets.bottom + S.lg, paddingHorizontal: S.xl, gap: S.xl }}>
        <View style={{ gap: S.sm }}>
          <Wordmark size={34} />
          <Txt v="body" color={C.body} style={{ fontSize: 17, lineHeight: 24, marginTop: S.sm }}>L’anime et le manhwa, au même endroit.</Txt>
        </View>

        <View style={{ gap: S.lg }}>
          {POINTS.map((p) => (
            <View key={p.title} style={{ flexDirection: 'row', gap: S.md }}>
              <View style={{ width: 40, height: 40, borderRadius: 12, borderCurve: 'continuous', backgroundColor: C.elevated, borderWidth: 1, borderColor: C.accentLine, alignItems: 'center', justifyContent: 'center', boxShadow: SHADOW.inset }}>
                <Ionicons name={p.icon} size={18} color={C.accentText} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt v="label">{p.title}</Txt>
                <Txt v="small" style={{ lineHeight: 18 }}>{p.text}</Txt>
              </View>
            </View>
          ))}
        </View>

        <View style={{ flex: 1 }} />

        <CloudAccountCard onVisibleChange={setCloudCard} onFound={setCloudAccount} />

        <View style={{ gap: S.md }}>
          {error ? <Txt v="small" color={DANGER}>{error}</Txt> : null}
          <Button variant={cloudCard ? 'ghost' : 'solid'} large label={cloudCard ? 'Nouveau compte' : 'Commencer'} loading={busy} icon="arrow-forward" iconRight onPress={create} />
          <Pressable
            onPress={() => router.push('/onboarding/restore')}
            accessibilityRole="button"
            hitSlop={8}
            style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Txt v="label" color={C.accentText} style={F.semibold}>J’ai déjà un compte</Txt>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
