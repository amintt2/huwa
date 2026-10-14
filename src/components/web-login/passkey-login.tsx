// "Clé d’accès": the passkey that carries the account (src/p2p/passkey.ts, WebAuthn on the web).
// Only offered where it can work (D8, `passkeyLoginAvailable`).
import { useState } from 'react';
import { View } from 'react-native';

import { RestoreOfflineNotice } from '@/components/restore-offline';
import { Button } from '@/components/ui';
import { webSession } from '@/p2p';
import type { Profile, RestoreOptions } from '@/p2p/contract';
import { isRestoreNotFound } from '@/p2p/errors';
import { passkeyDetail, passkeyMessage, readPasskeyAccount, restoreFromPasskeyLogin, type PasskeyLogin as Login } from '@/p2p/passkey';
import { restoreWithPhrase } from '@/p2p/web/login';
import { S } from '@/theme/tokens';

import { useLoginMode } from './login-mode';
import { ErrorLine, errorText, useAbandonOnUnmount } from './parts';

export type PasskeyLoginProps = {
  onDone: (profile: Profile) => void;
  /** "Créer un nouveau compte à la place", offered when no device of the account answers. */
  onCreate?: () => void;
  /** Button style: `solid` when it is the screen's primary action. */
  variant?: 'solid' | 'soft' | 'ghost';
};

export function PasskeyLogin({ onDone, onCreate, variant = 'ghost' }: PasskeyLoginProps) {
  const { mode } = useLoginMode();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; detail?: string }>();
  /**
   * No device of the account answered: the passkey is asked once, its phrase is kept (this
   * component's memory only) for a retry or the explicit restore without the old data.
   */
  const [retry, setRetry] = useState<Login | null>(null);
  const flow = useAbandonOnUnmount();

  const restore = async (l: Login, opts?: RestoreOptions) => {
    setBusy(true);
    setError(undefined);
    flow.start();
    try {
      // Public computer: same restore, without the local passkey record (it would be written to disk).
      let profile: Profile;
      if (mode === 'memory') profile = await restoreWithPhrase(l.words, { mode, restore: opts });
      else {
        webSession()?.setLoginMode(mode);
        profile = await restoreFromPasskeyLogin(l, opts);
      }
      flow.finish();
      setRetry(null);
      onDone(profile);
    } catch (e) {
      if (isRestoreNotFound(e)) setRetry(l);
      else setError({ text: errorText(e, 'Restauration impossible.') });
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setRetry(null);
    let l: Login;
    try {
      l = await readPasskeyAccount();
    } catch (e) {
      setBusy(false);
      const text = passkeyMessage(e);
      if (text) setError({ text, detail: passkeyDetail(e) });
      return;
    }
    await restore(l);
  };

  return (
    <View style={{ gap: S.md }}>
      {retry ? (
        <RestoreOfflineNotice
          busy={busy}
          onRetry={() => restore(retry)}
          onRestoreWithoutData={(name) => restore(retry, { allowNewHome: true, name })}
          onNewAccount={onCreate}
        />
      ) : (
        <Button
          variant={variant}
          label="Se connecter avec une clé d’accès"
          icon="finger-print"
          loading={busy}
          accessibilityHint="Touch ID, Windows Hello, ton téléphone ou ton gestionnaire de mots de passe"
          onPress={start}
        />
      )}
      <ErrorLine text={error?.text} detail={error?.detail} />
    </View>
  );
}
