import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RestoreOfflineNotice } from '@/components/restore-offline';
import { DANGER, Field, Group, Row, ScreenHeader } from '@/components/social';
import { Button, Txt } from '@/components/ui';
import { cloudBackup, cloudBackupSupported } from '@/p2p/cloud-backup';
import { isRestoreNotFound } from '@/p2p/errors';
import { social } from '@/p2p/hooks';
import { PasskeyError, passkeyMessage, passkeySupport, requestPasskeyOffer, restoreWithPasskey } from '@/p2p/passkey';
import { PHRASE_WORDS, isValidPhrase, normalizePhraseInput, unknownWords } from '@/social/identity';
import { C, S } from '@/theme/tokens';

export default function Restore() {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** None of the account's devices answered: how to try the same restore again. */
  const [retry, setRetry] = useState<() => void>();

  /** Shared failure path: no success haptic, no iCloud save, no passkey offer. */
  const failed = (e: unknown, again: () => void) => {
    requestPasskeyOffer(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    setBusy(false);
    if (isRestoreNotFound(e)) {
      setRetry(() => again);
      return true;
    }
    return false;
  };

  const words = useMemo(() => normalizePhraseInput(text), [text]);
  const unknown = useMemo(() => unknownWords(words), [words]);
  const complete = words.length === PHRASE_WORDS;
  const valid = complete && isValidPhrase(words);

  const restore = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setError(undefined);
    setRetry(undefined);
    try {
      requestPasskeyOffer();
      await social.restoreIdentity(words);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      if (!failed(e, restore)) setError(e instanceof Error ? e.message : 'Restauration impossible.');
    }
  };

  const restoreFromPasskey = async (immediate = true): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setRetry(undefined);
    try {
      await restoreWithPasskey({ immediate });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setBusy(false);
      if (isRestoreNotFound(e)) {
        failed(e, () => restoreFromPasskey(immediate));
        return;
      }
      if (e instanceof PasskeyError && e.code === 'no-credentials' && immediate) {
        // Nothing on this iPhone: the system sheet can still use a passkey from a phone nearby (QR).
        Alert.alert('Aucune clé d’accès sur cet appareil', 'Tu peux utiliser une clé d’accès enregistrée sur un autre appareil à proximité.', [
          { text: 'Annuler', style: 'cancel' },
          { text: 'Autre appareil', onPress: () => restoreFromPasskey(false) },
        ]);
        return;
      }
      const message = passkeyMessage(e);
      if (message) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Clé d’accès', message);
      }
    }
  };

  const restoreFromCloud = async () => {
    if (busy) return;
    setError(undefined);
    const saved = await cloudBackup.load();
    if (!saved || !isValidPhrase(saved)) {
      Alert.alert(
        'Aucune sauvegarde trouvée',
        'Vérifie que le Trousseau iCloud est activé (Réglages → ton nom → iCloud → Mots de passe et trousseau) et que tu es connecté au même compte Apple que sur ton ancien iPhone. La synchronisation peut prendre quelques minutes.',
      );
      return;
    }
    setBusy(true);
    setRetry(undefined);
    try {
      requestPasskeyOffer();
      await social.restoreIdentity(saved);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      if (!failed(e, restoreFromCloud)) setError(e instanceof Error ? e.message : 'Restauration impossible.');
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
        {retry ? (
          <RestoreOfflineNotice
            busy={busy}
            onRetry={retry}
            onNewAccount={() => (router.canGoBack() ? router.back() : router.replace('/onboarding'))}
          />
        ) : null}
        <Group
          title="Le plus simple"
          footer="Sur ton autre appareil : Profil → Réglages → Sécurité → Lier un appareil. Un QR code s’affiche.">
          {passkeySupport.available && (
            <Row
              icon="finger-print"
              label="Se connecter avec une clé d’accès"
              detail={busy ? 'Connexion…' : 'Face ID ou ton gestionnaire de mots de passe'}
              onPress={() => restoreFromPasskey()}
            />
          )}
          <Row icon="qr-code-outline" label="Scanner depuis mon autre appareil" onPress={() => router.push('/onboarding/scan')} />
          {cloudBackupSupported ? (
            <Row icon="cloud-download-outline" label="Restaurer depuis iCloud" detail="Phrase sauvegardée dans ton Trousseau iCloud" onPress={restoreFromCloud} last />
          ) : (
            <Row icon="cloud-outline" label="Sauvegarde Google" detail="Bientôt disponible sur Android" disabled last />
          )}
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
              {hint ?? 'Ta phrase n’est envoyée à aucun serveur.'}
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
