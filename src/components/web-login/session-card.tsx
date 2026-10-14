// Settings → "Ce navigateur" on the web: name, storage mode, passkey lock, lock now, logout.
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { Group, Row } from '@/components/social';
import { browserLabel } from '@/p2p/web/device-name';
import { lockSession, useWebSession, type WebSessionInfo } from '@/p2p/web/login';
import { disablePasskeyLock, enablePasskeyLock, passkeyLockSupported } from '@/p2p/web/passkey-lock';
import { C, S } from '@/theme/tokens';

import { ConfirmBox, ErrorLine } from './parts';
import { LOGOUT_TEXT, lockErrorText, useLogout } from './session-actions';

const STORAGE: Record<NonNullable<WebSessionInfo['mode']>, string> = {
  device: 'Cet ordinateur',
  memory: 'Ordinateur public : rien n’est enregistré',
  passkey: 'Verrouillé par une clé d’accès',
};

export function WebSessionCard() {
  const session = useWebSession();
  const [busy, setBusy] = useState<'lock' | 'toggle'>();
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const logout = useLogout();

  const name = session.deviceName || browserLabel();
  const memory = session.mode === 'memory';
  const locked = session.mode === 'passkey';
  const canLock = !memory && passkeyLockSupported() && session.state === 'ready';

  const toggle = async (on: boolean) => {
    if (busy) return;
    setBusy('toggle');
    setError(undefined);
    try {
      await (on ? enablePasskeyLock(name) : disablePasskeyLock());
    } catch (e) {
      setError(lockErrorText(e));
    } finally {
      setBusy(undefined);
    }
  };

  const lockNow = async () => {
    if (busy) return;
    setBusy('lock');
    setError(undefined);
    try {
      await lockSession();
    } catch (e) {
      setError(lockErrorText(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <View style={{ gap: S.md }}>
      <Group
        title="Ce navigateur"
        footer={
          canLock
            ? 'Verrouillé, ton compte n’ouvre sur cet ordinateur qu’après Touch ID, Windows Hello ou ton téléphone. Cette clé d’accès ne sert qu’à ce navigateur.'
            : memory
              ? 'Ferme tous les onglets Huwa pour effacer la session.'
              : undefined
        }>
        <Row icon="desktop-outline" label={name} detail={session.mode ? STORAGE[session.mode] : undefined} />
        {canLock ? (
          <Row
            icon="finger-print"
            label="Verrouiller avec une clé d’accès"
            detail={busy === 'toggle' ? 'Clé d’accès en cours…' : undefined}
            right={
              <Switch
                value={locked}
                onValueChange={(v) => void toggle(v)}
                disabled={!!busy}
                trackColor={{ false: C.borderStrong, true: C.accent }}
                accessibilityLabel="Verrouiller avec une clé d’accès"
              />
            }
          />
        ) : null}
        {locked && session.state === 'ready' ? (
          <Row icon="lock-closed-outline" label="Verrouiller maintenant" detail={busy === 'lock' ? 'Verrouillage…' : undefined} onPress={() => void lockNow()} disabled={!!busy} />
        ) : null}
        <Row icon="log-out-outline" label="Se déconnecter de ce navigateur" destructive onPress={() => setConfirm(true)} disabled={!!busy || logout.busy} last />
      </Group>
      <ErrorLine text={error} />
      {confirm && !logout.notice ? (
        <ConfirmBox
          title="Se déconnecter de ce navigateur ?"
          confirmLabel="Se déconnecter"
          busy={logout.busy}
          onConfirm={logout.run}
          onCancel={() => setConfirm(false)}
          destructive>
          {LOGOUT_TEXT}
        </ConfirmBox>
      ) : null}
      <ErrorLine text={logout.error} />
      {logout.notice}
    </View>
  );
}
