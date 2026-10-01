// Onboarding: an account phrase already in iCloud Keychain (e.g. new iPhone, same Apple account)
// is offered first — one tap restores it. The keychain is read in the background; the card only
// slides in when something valid is found (unavailable keychain / invalid item → nothing shown).
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOut } from 'react-native-reanimated';

import { cloudBackup, cloudBackupSupported } from '@/p2p/cloud-backup';
import { social } from '@/p2p/hooks';
import { hintLabel, type AccountHint } from '@/p2p/passkey-core';
import { requestPasskeyOffer } from '@/p2p/passkey';
import { isValidPhrase } from '@/social/identity';
import { C, F, R, S } from '@/theme/tokens';

import { Avatar, DANGER } from './social';
import { Button, Txt } from './ui';

type Found = { words: string[]; hint?: AccountHint };

export function CloudAccountCard({
  onVisibleChange,
  onFound,
}: {
  onVisibleChange?: (visible: boolean) => void;
  /** A valid phrase is in iCloud Keychain (even if the card is dismissed afterwards): its owner's name when known. */
  onFound?: (account: { name?: string }) => void;
}) {
  const [found, setFound] = useState<Found>();
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!cloudBackupSupported) return;
    let alive = true;
    Promise.all([cloudBackup.load().catch(() => undefined), cloudBackup.loadHint().catch(() => undefined)])
      .then(([words, hint]) => {
        if (alive && words && isValidPhrase(words)) setFound({ words, hint });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (found) onFound?.({ name: found.hint?.name });
  }, [found, onFound]);

  const visible = !!found && !dismissed;
  useEffect(() => {
    onVisibleChange?.(visible);
  }, [visible, onVisibleChange]);

  if (!visible || !found) return null;
  const label = hintLabel(found.hint);

  const restore = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      requestPasskeyOffer();
      await social.restoreIdentity(found.words);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // The protected stack switches to the app on its own.
    } catch (e) {
      requestPasskeyOffer(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(e instanceof Error ? e.message : 'Restauration impossible.');
      setBusy(false);
    }
  };

  return (
    <Animated.View entering={FadeInDown.duration(380)} exiting={FadeOut.duration(160)} style={styles.card}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        {label.initial ? (
          <Avatar seed={found.hint?.fingerprint ?? label.title} name={label.title} size={44} />
        ) : (
          <View style={styles.icon}>
            <Ionicons name="cloud-done-outline" size={22} color={C.accentText} />
          </View>
        )}
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="small">Compte trouvé dans ton trousseau iCloud</Txt>
          <Txt v="label" numberOfLines={1} style={{ fontSize: 17 }}>
            {label.title}
            {label.detail ? <Txt v="small">{`  ${label.detail}`}</Txt> : null}
          </Txt>
        </View>
      </View>
      {error ? <Txt v="small" color={DANGER}>{error}</Txt> : null}
      <Button label={busy ? 'Connexion…' : label.action} icon="log-in-outline" onPress={restore} />
      <Pressable
        onPress={() => setDismissed(true)}
        disabled={busy}
        accessibilityRole="button"
        hitSlop={8}
        style={{ minHeight: 36, alignItems: 'center', justifyContent: 'center' }}>
        <Txt v="label" color={C.accentText} style={F.semibold}>Utiliser un autre compte</Txt>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: S.md, padding: S.lg, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.accentLine,
  },
  icon: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.accentSoft, alignItems: 'center', justifyContent: 'center' },
});
