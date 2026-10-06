import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CloudAccountCard } from '@/components/cloud-account';
import { Field } from '@/components/social';
import { Button, Txt, Wordmark, type IconName } from '@/components/ui';
import { social } from '@/p2p/hooks';
import { requestPasskeyOffer } from '@/p2p/passkey';
import { getState } from '@/store/store';
import { C, F, S, SHADOW } from '@/theme/tokens';

const POINTS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'key-outline', title: 'Ton compte, ta clé', text: 'Ton identité est une clé créée sur ce téléphone. Aucun serveur ne la détient.' },
  { icon: 'people-outline', title: 'Entre fans, sans intermédiaire', text: 'Commentaires, abonnements et messages passent de pair à pair.' },
  { icon: 'trophy-outline', title: 'Un rang vérifiable', text: 'Ce que tu regardes et lis te fait progresser. Chacun peut le recalculer.' },
];

export default function Welcome() {
  const insets = useSafeAreaInsets();
  const legacy = getState().userName;
  const [name, setName] = useState(legacy && legacy !== 'moi' ? legacy : '');
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
      `Ton Trousseau iCloud contient déjà ${who}. Créer une nouvelle identité remplacera cette sauvegarde sur tous tes appareils Apple : si sa phrase n’est pas notée ailleurs, cet ancien compte sera perdu.`,
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
      requestPasskeyOffer();
      await social.createIdentity(name);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // The protected stack now switches to the app on its own.
    } catch (e) {
      requestPasskeyOffer(false);
      setError(e instanceof Error ? e.message : 'Impossible de créer l’identité.');
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
          <Txt v="body" color={C.body} style={{ fontSize: 17, lineHeight: 24, marginTop: S.sm }}>L’anime et le manhwa, au même endroit. Et ta communauté, sans serveur.</Txt>
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
          <Field
            label="Choisis un pseudo"
            value={name}
            onChangeText={(t) => {
              setName(t);
              setError(undefined);
            }}
            placeholder="ex. mira.reads"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={24}
            returnKeyType="done"
            onSubmitEditing={create}
            error={error}
            hint="Deux personnes peuvent avoir le même pseudo : une empreinte courte s’affiche à côté pour les distinguer."
          />
          <Button variant={cloudCard ? 'ghost' : 'solid'} large label="Créer mon identité" loading={busy} icon="sparkles" onPress={create} />
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
