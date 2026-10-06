import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RestoreOfflineNotice } from '@/components/restore-offline';
import { DANGER, Field, Group, Row, ScreenHeader } from '@/components/social';
import { Button, Txt } from '@/components/ui';
import { cloudBackup, cloudBackupSupported } from '@/p2p/cloud-backup';
import { errorCode, isRestoreNotFound } from '@/p2p/errors';
import { social } from '@/p2p/hooks';
import type { RestoreOptions } from '@/p2p/contract';
import { PasskeyError, passkeyDetail, passkeyMessage, passkeySupport, readPasskeyAccount, requestPasskeyOffer, restoreFromPasskeyLogin, type PasskeyLogin } from '@/p2p/passkey';
import type { AccountHint } from '@/p2p/passkey-core';
import { PHRASE_WORDS, isValidPhrase, normalizePhraseInput, unknownWords } from '@/social/identity';
import { C, S } from '@/theme/tokens';

/** A restore that found no device of the account: what to retry, or restore without the old data. */
type Pending = { words: string[]; hint?: AccountHint; login?: PasskeyLogin };

export default function Restore() {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** None of the account's devices answered (nothing was changed). */
  const [pending, setPending] = useState<Pending>();

  const words = useMemo(() => normalizePhraseInput(text), [text]);
  const unknown = useMemo(() => unknownWords(words), [words]);
  const complete = words.length === PHRASE_WORDS;
  const valid = complete && isValidPhrase(words);

  /**
   * Shared by the phrase, iCloud and passkey paths (the passkey is only asked once: its phrase is
   * kept for retries). `opts.allowNewHome` only after the explicit choice in RestoreOfflineNotice.
   */
  const run = async (p: Pending, opts?: RestoreOptions) => {
    setBusy(true);
    setError(undefined);
    try {
      if (!p.login) requestPasskeyOffer();
      if (p.login) await restoreFromPasskeyLogin(p.login, opts);
      else await social.restoreIdentity(p.words, opts);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // The protected stack switches to the app on its own.
    } catch (e) {
      // No success haptic, no iCloud save, no passkey offer.
      requestPasskeyOffer(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      console.warn('[huwa] restore failed', errorCode(e) ?? '', e instanceof Error ? e.message : e);
      if (isRestoreNotFound(e)) {
        setPending({ ...p, hint: p.hint ?? (await cloudBackup.hintFor(p.words).catch(() => undefined)) });
      } else {
        const message = e instanceof Error ? e.message : 'Restauration impossible.';
        if (pending) Alert.alert('Restauration impossible', message);
        else setError(message);
      }
      setBusy(false);
    }
  };

  const restore = () => {
    if (busy || !valid) return;
    setPending(undefined);
    return run({ words });
  };

  const restoreFromPasskey = async (immediate = true): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setPending(undefined);
    let login: PasskeyLogin;
    try {
      login = await readPasskeyAccount({ immediate });
    } catch (e) {
      setBusy(false);
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
        const detail = passkeyDetail(e);
        console.warn('[huwa] passkey restore', detail);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Clé d’accès', detail ? `${message}\n\nDétail : ${detail}` : message);
      }
      return;
    }
    await run({ words: login.words, login });
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
    setPending(undefined);
    await run({ words: saved, hint: await cloudBackup.loadHint().catch(() => undefined) });
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
        {pending ? (
          <RestoreOfflineNotice
            busy={busy}
            hint={pending.hint}
            onRetry={() => run(pending)}
            onRestoreWithoutData={(name) => run(pending, { allowNewHome: true, name })}
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
