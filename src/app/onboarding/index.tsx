import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Field } from '@/components/social';
import { Button, Txt, type IconName } from '@/components/ui';
import { social } from '@/p2p/hooks';
import { getState } from '@/store/store';
import { C, F, S } from '@/theme/tokens';

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

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await social.createIdentity(name);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // The protected stack now switches to the app on its own.
    } catch (e) {
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
          <Txt v="display" style={{ fontSize: 40, letterSpacing: 2 }}>Huwa</Txt>
          <Txt v="body" style={{ fontSize: 17, lineHeight: 24 }}>L’anime et le manhwa, au même endroit. Et ta communauté, sans serveur.</Txt>
        </View>

        <View style={{ gap: S.lg }}>
          {POINTS.map((p) => (
            <View key={p.title} style={{ flexDirection: 'row', gap: S.md }}>
              <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
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
          />
          <Txt v="small" style={{ lineHeight: 18 }}>
            Deux personnes peuvent avoir le même pseudo : une empreinte courte s’affiche à côté pour les distinguer.
          </Txt>
          <Button label={busy ? 'Création…' : 'Créer mon identité'} icon="sparkles" onPress={create} />
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
