// Restore found no device of the account online: nothing was changed. The user can retry once a
// device is open, or — when every device is gone — explicitly restore the identity without the
// data that lived on those devices (worklet `restoreIdentity(…, { allowNewHome: true })`).
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { AccountHint } from '@/p2p/passkey-core';
import { C, F, R, S } from '@/theme/tokens';

import { Field } from './social';
import { Button, Txt } from './ui';

const LOST = [
  'Tu gardes la même identité : même clé, même empreinte. Tes commentaires restent à toi et les autres te reconnaissent.',
  'Ce qui n’existait que sur tes anciens appareils est perdu : bio, avatar, historique, abonnements, messages et liste d’appareils.',
  'Si un ancien appareil se reconnecte plus tard, ses données ne seront pas fusionnées automatiquement.',
];

const validName = (n: string) => {
  const t = n.trim();
  return t.length >= 2 && t.length <= 24;
};

export function RestoreOfflineNotice({
  busy,
  hint,
  onRetry,
  onRestoreWithoutData,
  onNewAccount,
}: {
  busy: boolean;
  /** iCloud account hint of the phrase being restored, when known (name shown, used as default pseudo). */
  hint?: AccountHint;
  onRetry: () => void;
  /** Explicit consent: same identity, fresh profile named `name`, old data not recovered. */
  onRestoreWithoutData?: (name: string) => void;
  onNewAccount?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState(hint?.name ?? '');
  const account = hint?.name ? `${hint.name}${hint.fingerprint ? ` · ${hint.fingerprint}` : ''}` : hint?.fingerprint ? `Compte ${hint.fingerprint}` : undefined;

  return (
    <View style={styles.card} accessibilityRole="alert">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        <View style={styles.icon}>
          <Ionicons name="cloud-offline-outline" size={22} color={C.accentText} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="label" style={{ fontSize: 17 }}>Aucun de tes appareils n’a répondu.</Txt>
          {account ? <Txt v="small" numberOfLines={1}>{account}</Txt> : null}
        </View>
      </View>

      {!confirming ? (
        <>
          <Txt v="small" style={{ lineHeight: 18 }}>
            Ton compte n’a pas été modifié. Si un appareil connecté à ce compte existe encore, ouvre Huwa dessus (au premier plan), puis réessaie.
          </Txt>
          <Button label="Réessayer" icon="refresh" loading={busy} accessibilityHint="Cherche à nouveau tes appareils pendant quelques secondes" onPress={onRetry} />
          {onRestoreWithoutData ? (
            <Pressable onPress={() => setConfirming(true)} disabled={busy} accessibilityRole="button" hitSlop={8} style={styles.link}>
              <Txt v="label" color={C.accentText} style={[F.semibold, { textAlign: 'center' }]}>Restaurer mon identité sans mes anciennes données</Txt>
            </Pressable>
          ) : null}
          {onNewAccount ? (
            <Pressable onPress={onNewAccount} disabled={busy} accessibilityRole="button" hitSlop={8} style={styles.link}>
              <Txt v="label" color={C.accentText} style={F.semibold}>Créer un nouveau compte à la place</Txt>
            </Pressable>
          ) : null}
        </>
      ) : (
        <>
          <Txt v="small" style={{ lineHeight: 18, color: C.text }}>
            À utiliser seulement si tu n’as plus aucun appareil connecté à ce compte.
          </Txt>
          <View style={{ gap: S.sm }}>
            {LOST.map((t) => (
              <View key={t} style={{ flexDirection: 'row', gap: S.sm }}>
                <Txt v="small">•</Txt>
                <Txt v="small" style={{ flex: 1, lineHeight: 18 }}>{t}</Txt>
              </View>
            ))}
          </View>
          <Field
            label="Pseudo"
            value={name}
            onChangeText={setName}
            placeholder="ex. mira.reads"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={24}
            editable={!busy}
          />
          <Button
            label="Restaurer sans mes données"
            icon="key"
            loading={busy}
            disabled={!validName(name)}
            onPress={() => onRestoreWithoutData?.(name.trim())}
          />
          <Pressable onPress={() => setConfirming(false)} disabled={busy} accessibilityRole="button" hitSlop={8} style={styles.link}>
            <Txt v="label" color={C.accentText} style={F.semibold}>Annuler</Txt>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: S.md, padding: S.lg, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.accentLine,
  },
  icon: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.accentSoft, alignItems: 'center', justifyContent: 'center' },
  link: { minHeight: 36, alignItems: 'center', justifyContent: 'center' },
});
