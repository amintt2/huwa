// Session locked by a passkey (D6): the account on this computer opens after the passkey's user
// verification. Shown by the root layout while `useWebSession().state === 'locked'`.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/social';
import { Button, Txt, Wordmark } from '@/components/ui';
import { unlockWithPasskey } from '@/p2p/web/passkey-lock';
import { useWebSession } from '@/p2p/web/login';
import { C, S } from '@/theme/tokens';

import { ConfirmBox, ErrorLine, LinkButton, LoginFrame } from './parts';
import { LOGOUT_TEXT, lockErrorText, useLogout } from './session-actions';

export type WebUnlockScreenProps = {
  /** Called once the session is unlocked (the session state also switches to 'ready'). */
  onUnlocked?: () => void;
};

export function WebUnlockScreen({ onUnlocked }: WebUnlockScreenProps) {
  const session = useWebSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const logout = useLogout();

  const unlock = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await unlockWithPasskey();
      onUnlocked?.();
    } catch (e) {
      setError(lockErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const me = session.me;
  return (
    <LoginFrame>
      <Wordmark size={28} />
      <View style={{ alignItems: 'center', gap: S.md }}>
        <View style={styles.lock}>
          <Ionicons name="lock-closed" size={28} color={C.accentText} />
        </View>
        <Txt v="title" accessibilityRole="header" style={{ textAlign: 'center' }}>Session verrouillée</Txt>
        {me ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
            <Avatar seed={me.key} name={me.name} size={28} />
            <Txt v="label">{me.name}</Txt>
            <Txt v="small">{me.fingerprint}</Txt>
          </View>
        ) : null}
        <Txt v="body" style={{ textAlign: 'center', maxWidth: 360 }}>
          Ton compte est chiffré sur cet ordinateur. Confirme avec ta clé d’accès pour l’ouvrir.
        </Txt>
      </View>

      {confirm ? (
        <ConfirmBox
          title="Se déconnecter de ce navigateur ?"
          confirmLabel="Se déconnecter"
          busy={logout.busy}
          onConfirm={logout.run}
          onCancel={() => setConfirm(false)}
          destructive>
          {LOGOUT_TEXT}
        </ConfirmBox>
      ) : (
        <View style={{ gap: S.sm }}>
          <Button large label="Déverrouiller avec ma clé d’accès" icon="finger-print" loading={busy} onPress={unlock} />
          <ErrorLine text={error} />
          <LinkButton label="Se déconnecter de ce navigateur" onPress={() => setConfirm(true)} disabled={busy} />
        </View>
      )}
      <ErrorLine text={logout.error} />
      {logout.notice}
    </LoginFrame>
  );
}

const styles = StyleSheet.create({
  lock: { width: 64, height: 64, borderRadius: 32, backgroundColor: C.accentSoft, alignItems: 'center', justifyContent: 'center' },
});
