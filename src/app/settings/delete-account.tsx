// Réglages → Sécurité → « Supprimer mon compte ». Explains exactly what is erased and what can't
// be, then asks the user to type SUPPRIMER before wiping (src/settings/delete-account.ts).
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DANGER, Field, Group, Row, ScreenHeader } from '@/components/social';
import { Button, Txt, type IconName } from '@/components/ui';
import { cloudBackupSupported, useCloudBackup } from '@/p2p/cloud-backup';
import { useMe, useSecurity } from '@/p2p/hooks';
import { passkeySupport, usePasskeyRecord } from '@/p2p/passkey';
import { deleteAccount } from '@/settings/delete-account';
import { C, R, S } from '@/theme/tokens';

const WORD = 'SUPPRIMER';

function Point({ icon, title, text, tone }: { icon: IconName; title: string; text: string; tone?: 'danger' }) {
  return (
    <View style={styles.point}>
      <Ionicons name={icon} size={18} color={tone === 'danger' ? DANGER : C.accentText} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="label" style={{ fontSize: 14 }}>{title}</Txt>
        <Txt v="small" style={{ lineHeight: 18 }}>{text}</Txt>
      </View>
    </View>
  );
}

export default function DeleteAccount() {
  const insets = useSafeAreaInsets();
  const me = useMe();
  const { devices } = useSecurity();
  const cloud = useCloudBackup();
  const passkey = usePasskeyRecord(me?.key);
  const hasCloudCopy = cloudBackupSupported && cloud.saved;
  const [removeCloud, setRemoveCloud] = useState(true);
  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<'form' | 'busy' | 'done'>('form');
  const others = devices.filter((d) => !d.current && !d.revoked).length;
  const ready = typed.trim().toUpperCase() === WORD;

  const confirm = () =>
    Alert.alert(
      'Supprimer ton compte ?',
      hasCloudCopy && removeCloud
        ? 'Tout ce que Huwa garde sur cet appareil et la copie iCloud de ta phrase seront effacés. C’est définitif.'
        : 'Tout ce que Huwa garde sur cet appareil sera effacé. C’est définitif.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: async () => {
            setPhase('busy');
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            const { restarted } = await deleteAccount({ removeCloudCopy: hasCloudCopy && removeCloud });
            if (!restarted) setPhase('done');
          },
        },
      ],
    );

  if (phase === 'done') {
    // The app could not restart itself: nothing of the old account is usable any more.
    return (
      <View style={[styles.done, { paddingTop: insets.top + S.xxl, paddingBottom: insets.bottom + S.xl }]}>
        <Ionicons name="checkmark-circle" size={48} color={C.accentText} />
        <Txt v="title" style={{ textAlign: 'center' }}>Compte supprimé</Txt>
        <Txt v="body" style={{ textAlign: 'center' }}>
          Les données de cet appareil sont effacées. Ferme Huwa (balaye-la vers le haut dans le sélecteur d’apps) : au prochain lancement, tu repartiras de zéro.
        </Txt>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <ScreenHeader title="Supprimer le compte" />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{ paddingHorizontal: S.lg, paddingBottom: insets.bottom + S.xxl, gap: S.xl }}>
        <Txt v="body">
          Huwa n’a pas de serveur : ton compte, c’est ta clé d’identité et ce que tes appareils gardent. Voici ce que la suppression fait.
        </Txt>

        <View style={styles.card}>
          <Point icon="trash-outline" tone="danger" title="Effacé de cet appareil"
            text="Ta clé d’identité et ta phrase de récupération (Trousseau), ta progression, tes listes, tes messages et commentaires stockés ici, tes réglages, tes extensions et tes téléchargements." />
          {hasCloudCopy && (
            <View style={styles.switchRow}>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt v="label" style={{ fontSize: 14 }}>Supprimer aussi la copie iCloud</Txt>
                <Txt v="small" style={{ lineHeight: 18 }}>
                  Ta phrase est dans ton Trousseau iCloud. La retirer l’efface de tous tes appareils Apple : sans phrase notée ailleurs, le compte sera irrécupérable.
                </Txt>
              </View>
              <Switch value={removeCloud} onValueChange={setRemoveCloud} trackColor={{ true: DANGER }} accessibilityLabel="Supprimer aussi la copie iCloud" />
            </View>
          )}
          {passkeySupport.available && (
            <Point icon="finger-print" title={passkey ? 'Ta clé d’accès reste à supprimer' : 'Clé d’accès'}
              text="iOS ne laisse pas une app effacer une clé d’accès. Si tu en as créé une, supprime-la toi-même : Réglages → Mots de passe (ou l’app Mots de passe), entrée « huwa.mciut.fr »." />
          )}
          <Point icon="git-network-outline" title="Ce qui est déjà chez les pairs"
            text="Tes commentaires, ton profil public et les messages envoyés ont été copiés chez les personnes et pairs qui les ont reçus. Huwa ne peut pas les rappeler. Pour retirer un commentaire, supprime-le avant : les pairs qui se reconnectent appliquent la suppression, mais ce qui a déjà été lu ou copié reste." />
          {others > 0 && (
            <Point icon="phone-portrait-outline" title={`${others} autre${others > 1 ? 's' : ''} appareil${others > 1 ? 's' : ''} lié${others > 1 ? 's' : ''}`}
              text={
                others > 1
                  ? 'Ils gardent le compte. Révoque-les dans Sécurité → Appareils liés ou supprime aussi le compte sur chacun.'
                  : 'Il garde le compte. Révoque-le dans Sécurité → Appareils liés ou supprime aussi le compte dessus.'
              } />
          )}
        </View>

        <Group title="Confirmation" footer={`Tape ${WORD} pour activer le bouton.`}>
          <View style={{ padding: S.md }}>
            <Field value={typed} onChangeText={setTyped} placeholder={WORD} autoCapitalize="characters" autoCorrect={false} accessibilityLabel={`Tape ${WORD} pour confirmer`} />
          </View>
          <Row icon="close-circle-outline" label="Je garde mon compte" onPress={() => setTyped('')} chevron={false} last />
        </Group>

        <View style={{ opacity: ready && phase === 'form' ? 1 : 0.45 }}>
          <Button
            label={phase === 'busy' ? 'Suppression…' : 'Supprimer définitivement'}
            icon="trash"
            onPress={ready && phase === 'form' ? confirm : undefined}
            style={{ backgroundColor: DANGER }}
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: S.lg, padding: S.lg, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  point: { flexDirection: 'row', gap: S.md },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: 12, backgroundColor: 'rgba(255,107,107,0.08)' },
  done: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', gap: S.lg, paddingHorizontal: S.xl },
});
