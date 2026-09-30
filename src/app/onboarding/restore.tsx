import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DANGER, Field, Group, Row, ScreenHeader } from '@/components/social';
import { Button, Txt } from '@/components/ui';
import { social } from '@/p2p/hooks';
import { PHRASE_WORDS, isValidPhrase, normalizePhraseInput, unknownWords } from '@/social/identity';
import { C, S } from '@/theme/tokens';

export default function Restore() {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const words = useMemo(() => normalizePhraseInput(text), [text]);
  const unknown = useMemo(() => unknownWords(words), [words]);
  const complete = words.length === PHRASE_WORDS;
  const valid = complete && isValidPhrase(words);

  const restore = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setError(undefined);
    try {
      await social.restoreIdentity(words);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restauration impossible.');
      setBusy(false);
    }
  };

  const hint = unknown.length
    ? `Mot${unknown.length > 1 ? 's' : ''} inconnu${unknown.length > 1 ? 's' : ''} : ${unknown.map((i) => `n° ${i + 1} « ${words[i]} »`).join(', ')}`
    : complete && !valid
      ? 'Les 24 mots sont reconnus mais la phrase ne correspond pas : vérifie leur ordre.'
      : undefined;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title="J’ai déjà un compte" />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: S.lg, paddingBottom: insets.bottom + S.xl, gap: S.xl }}>
        <Group
          title="Le plus simple"
          footer="Sur ton autre appareil : Profil → Réglages → Sécurité → Lier un appareil. Un QR code s’affiche.">
          <Row icon="qr-code-outline" label="Scanner depuis mon autre appareil" onPress={() => router.push('/onboarding/scan')} />
          <Row icon="cloud-outline" label="Sauvegarde iCloud / Google" detail="Bientôt disponible" disabled last />
        </Group>

        <View style={{ gap: S.md }}>
          <Txt v="caption" style={{ paddingHorizontal: S.xs }}>Phrase de récupération</Txt>
          <Field
            value={text}
            onChangeText={(t) => {
              setText(t);
              setError(undefined);
            }}
            placeholder="Saisis tes 24 mots, dans l’ordre, séparés par des espaces"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            multiline
            accessibilityLabel="Phrase de récupération"
            error={error}
          />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: S.md }}>
            <Txt v="small" color={hint ? DANGER : C.text2} style={{ flex: 1, lineHeight: 18 }}>
              {hint ?? 'Ta phrase ne quitte jamais cet appareil.'}
            </Txt>
            <Txt v="small" color={complete ? C.accentText : C.text2} style={{ fontVariant: ['tabular-nums'] }}>
              {`${words.length}/${PHRASE_WORDS}`}
            </Txt>
          </View>
          <View style={{ opacity: valid ? 1 : 0.45 }}>
            <Button label={busy ? 'Restauration…' : 'Restaurer mon compte'} icon="key" onPress={restore} />
          </View>
        </View>

        <Txt v="small" style={{ lineHeight: 18 }}>
          Sans phrase, sans autre appareil et sans sauvegarde, un compte ne peut pas être récupéré : personne d’autre ne détient ta clé.
        </Txt>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
