// « Ajoute une clé d'accès »: proposed after creating/restoring an account, and from Réglages → Sécurité.
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CloseButton } from '@/components/screen';
import { DANGER, WARN } from '@/components/social';
import { Button, Txt, type IconName } from '@/components/ui';
import { useMe } from '@/p2p/hooks';
import { PasskeyError, createPasskey, passkeyMessage, type PasskeyRecord, type SetupStep } from '@/p2p/passkey';
import { C, S, SHADOW } from '@/theme/tokens';

type Phase =
  | { k: 'intro' }
  | { k: 'working'; step: SetupStep }
  | { k: 'done'; record: PasskeyRecord }
  | { k: 'no-large-blob' }
  | { k: 'error'; message: string };

const STEP: Record<SetupStep, string> = {
  register: 'Création de la clé d’accès…',
  unlock: 'Déverrouillage de la clé…',
  write: 'Enregistrement de ton compte dans la clé…',
  done: 'Terminé',
};

export default function PasskeySetup() {
  const insets = useSafeAreaInsets();
  const me = useMe();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const recreate = mode === 'recreate';
  const [phase, setPhase] = useState<Phase>({ k: 'intro' });

  const create = async () => {
    if (!me || phase.k === 'working') return;
    setPhase({ k: 'working', step: 'register' });
    try {
      const record = await createPasskey(me, (step) => setPhase({ k: 'working', step }));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPhase({ k: 'done', record });
    } catch (e) {
      if (e instanceof PasskeyError && e.code === 'no-large-blob') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return setPhase({ k: 'no-large-blob' });
      }
      const message = passkeyMessage(e);
      if (!message) return setPhase({ k: 'intro' });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setPhase({ k: 'error', message });
    }
  };

  let body;
  if (phase.k === 'done') {
    const r = phase.record;
    body = (
      <>
        <Badge icon="checkmark-circle" />
        <Txt v="display" style={styles.title} accessibilityRole="header">Clé d’accès créée</Txt>
        <Txt v="body" style={styles.text}>
          {`${r.provider ? `Enregistrée dans ${r.provider}. ` : ''}Sur un nouvel appareil : « J’ai déjà un compte » puis « Se connecter avec une clé d’accès ».`}
        </Txt>
        {!r.prf && (
          <Txt v="small" style={styles.note}>
            Ton gestionnaire protège ta phrase par la clé d’accès et la chiffre de bout en bout ; Huwa ne la voit jamais passer par un serveur.
          </Txt>
        )}
        <View style={styles.actions}>
          <Button label="Terminé" icon="checkmark" onPress={() => router.back()} />
        </View>
      </>
    );
  } else if (phase.k === 'no-large-blob') {
    body = (
      <>
        <Badge icon="alert-circle" color={WARN} />
        <Txt v="display" style={styles.title} accessibilityRole="header">Ce gestionnaire ne peut pas porter ton compte</Txt>
        <Txt v="body" style={styles.text}>
          Il crée bien des clés d’accès, mais sans l’espace de stockage dont Huwa a besoin. Ta phrase de récupération et le Trousseau iCloud restent tes moyens de retrouver ton compte.
        </Txt>
        <Txt v="small" style={styles.note}>
          La clé d’accès créée ne sert à rien : tu peux la supprimer dans ton gestionnaire de mots de passe. Le Trousseau iCloud, lui, la prend en charge.
        </Txt>
        <View style={styles.actions}>
          <Button label="Essayer un autre gestionnaire" icon="refresh" onPress={create} />
          <Button variant="ghost" label="Fermer" onPress={() => router.back()} />
        </View>
      </>
    );
  } else {
    const working = phase.k === 'working';
    body = (
      <>
        <Badge icon="finger-print" />
        <Txt v="display" style={styles.title} accessibilityRole="header">
          {recreate ? 'Recréer la clé d’accès' : 'Ajoute une clé d’accès'}
        </Txt>
        <Txt v="body" style={styles.text}>
          Retrouve ton compte sur n’importe quel appareil avec Face ID ou ton gestionnaire de mots de passe (iCloud, 1Password, Bitwarden, Google…).
        </Txt>
        <Txt v="body" style={styles.text}>Pas de mot de passe, et rien n’est stocké sur un serveur Huwa.</Txt>
        {recreate && (
          <Txt v="small" style={styles.note}>Dans le Trousseau iCloud, la nouvelle clé remplace l’ancienne.</Txt>
        )}
        {phase.k === 'error' && (
          <Txt v="small" color={DANGER} style={styles.note} accessibilityLiveRegion="polite">{phase.message}</Txt>
        )}
        <View style={styles.actions}>
          {working ? (
            <View style={styles.working} accessibilityLiveRegion="polite">
              <ActivityIndicator color={C.accentText} />
              <Txt v="label">{STEP[phase.step]}</Txt>
            </View>
          ) : (
            <Button label={recreate ? 'Recréer la clé d’accès' : 'Créer la clé d’accès'} icon="key" onPress={create} />
          )}
          <Button variant="ghost" label="Plus tard" onPress={() => router.back()} />
        </View>
      </>
    );
  }

  return (
    // Form sheet: everything, close button included, lives inside the ScrollView.
    <ScrollView style={{ flex: 1, backgroundColor: C.surface }} contentContainerStyle={{ paddingHorizontal: S.xl, paddingTop: S.xl, paddingBottom: insets.bottom + S.xl, gap: S.md }}>
      <View style={styles.closeRow}>
        <CloseButton onPress={() => router.back()} />
      </View>
      {body}
    </ScrollView>
  );
}

function Badge({ icon, color = C.accentText }: { icon: IconName; color?: string }) {
  return (
    <View style={styles.badge}>
      <Ionicons name={icon} size={30} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  closeRow: { position: 'absolute', top: S.lg, right: S.lg, zIndex: 1 },
  badge: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center', marginBottom: S.xs,
    borderWidth: 1, borderColor: C.accentLine, boxShadow: `0px 0px 0px 8px rgba(47,107,235,0.10), ${SHADOW.inset}`,
  },
  title: { fontSize: 26, lineHeight: 31, marginTop: S.sm },
  text: { fontSize: 16, lineHeight: 23 },
  note: { lineHeight: 18 },
  actions: { gap: S.sm, marginTop: S.md },
  working: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm },
});
