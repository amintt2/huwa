// "Créer un compte dans ce navigateur": pseudo → new identity → phrase backup (shown once).
import { useState } from 'react';
import { View } from 'react-native';

import { Field } from '@/components/social';
import { Button, Txt } from '@/components/ui';
import type { Profile } from '@/p2p/contract';
import { createAccount } from '@/p2p/web/login';
import { C, S } from '@/theme/tokens';

import { useLoginMode } from './login-mode';
import { LinkButton, LoginFrame, LoginTitle, errorText, useAbandonOnUnmount } from './parts';
import { PhraseBackup, setPendingBackup } from './phrase-backup';

const validName = (n: string) => {
  const t = n.trim();
  return t.length >= 2 && t.length <= 24;
};

export type CreateAccountProps = {
  /** After the backup step (verified or postponed). */
  onDone: (profile: Profile) => void;
  onBack?: () => void;
  /** "J’ai déjà un compte". */
  onHaveAccount?: () => void;
};

export function CreateAccount({ onDone, onBack, onHaveAccount }: CreateAccountProps) {
  const { mode } = useLoginMode();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<{ profile: Profile; phrase: string[] }>();
  const flow = useAbandonOnUnmount();

  const create = async () => {
    if (busy || !validName(name)) return;
    setBusy(true);
    setError(undefined);
    flow.start();
    try {
      const r = await createAccount(name.trim(), { mode });
      flow.finish();
      // Kept for PhraseBackupHost in case the `!me` guard unmounts this screen.
      setPendingBackup(r.phrase);
      setCreated(r);
    } catch (e) {
      setError(errorText(e, 'Impossible de créer le compte.'));
      setBusy(false);
    }
  };

  if (created)
    return (
      <LoginFrame center={false}>
        <PhraseBackup
          words={created.phrase}
          onFinish={() => {
            setPendingBackup(null);
            const { profile } = created;
            setCreated(undefined);
            onDone(profile);
          }}
        />
      </LoginFrame>
    );

  return (
    <LoginFrame onBack={onBack}>
      <LoginTitle
        title="Créer un compte"
        subtitle="Ton identité est une clé créée dans ce navigateur. Aucun serveur ne la détient : seule ta phrase de récupération permet de la retrouver."
      />
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
          autoComplete="off"
          autoFocus
          maxLength={24}
          returnKeyType="done"
          onSubmitEditing={create}
          editable={!busy}
          error={error}
          hint="Deux personnes peuvent avoir le même pseudo : une empreinte courte s’affiche à côté pour les distinguer."
        />
        <Button large label="Créer mon compte" icon="sparkles" loading={busy} disabled={!validName(name)} onPress={create} />
        {onHaveAccount ? <LinkButton label="J’ai déjà un compte" onPress={onHaveAccount} disabled={busy} /> : null}
      </View>
      {mode === 'memory' ? (
        <Txt v="footnote" color={C.text3} style={{ lineHeight: 17 }}>
          Ordinateur public : le compte n’existera que dans cet onglet. Note ta phrase pour le retrouver ailleurs.
        </Txt>
      ) : null}
    </LoginFrame>
  );
}
