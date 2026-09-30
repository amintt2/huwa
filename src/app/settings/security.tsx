import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Alert, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DANGER, Group, Loading, Row, ScreenHeader, WARN } from '@/components/social';
import { Button, Chip, Txt } from '@/components/ui';
import { cloudBackup, cloudBackupSupported, useCloudBackup } from '@/p2p/cloud-backup';
import { social, useMe, useSecurity } from '@/p2p/hooks';
import { C, R, S } from '@/theme/tokens';

const date = (t: number) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

export default function Security() {
  const insets = useSafeAreaInsets();
  const me = useMe();
  const { state, devices } = useSecurity();

  const revoke = (key: string, name: string) =>
    Alert.alert(
      `Révoquer « ${name} » ?`,
      'Cet appareil ne pourra plus publier en ton nom. La révocation est signée dans ton journal d’identité et relayée à tes pairs.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Révoquer',
          style: 'destructive',
          onPress: () => social.revokeDevice(key).catch((e) => Alert.alert('Impossible', e instanceof Error ? e.message : String(e))),
        },
      ],
    );

  const cloud = useCloudBackup();
  const cloudOn = cloud.enabled && cloud.saved;
  const safe = !!state?.phraseVerified || cloudOn;
  const level = !state ? 0 : (state.phraseVerified ? 1 : 0) + (state.cloud || cloudOn ? 1 : 0) + (state.devices > 1 ? 1 : 0);

  const toggleCloud = (on: boolean) => {
    if (on) {
      cloudBackup.setEnabled(true).catch((e) => Alert.alert('Trousseau iCloud', e instanceof Error ? e.message : String(e)));
      return;
    }
    Alert.alert(
      'Retirer la phrase d’iCloud ?',
      'La copie est supprimée de ton Trousseau iCloud sur tous tes appareils Apple. Garde ta phrase notée ailleurs.',
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Retirer', style: 'destructive', onPress: () => cloudBackup.setEnabled(false).catch(() => {}) },
      ],
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <ScreenHeader title="Sécurité" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: S.lg, paddingBottom: insets.bottom + S.xxl, gap: S.xl }}>
        {!state ? (
          <Loading />
        ) : (
          <View style={[styles.status, { borderColor: safe ? C.accentLine : 'rgba(255,200,87,0.35)' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
              <View style={[styles.statusIcon, { backgroundColor: safe ? C.accentSoft : 'rgba(255,200,87,0.14)' }]}>
                <Ionicons name={safe ? 'shield-checkmark' : 'warning'} size={22} color={safe ? C.accentText : WARN} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt v="label">{safe ? 'Ton compte est récupérable' : 'Ton compte n’est pas encore sauvegardé'}</Txt>
                <Txt v="small">{`Niveau de protection : ${level}/3`}</Txt>
              </View>
            </View>
            <Txt v="small" style={{ lineHeight: 18 }}>
              {safe
                ? cloudOn && !state.phraseVerified
                  ? 'Ta phrase est dans ton Trousseau iCloud : sur un nouvel iPhone connecté au même compte Apple, un tap suffit pour retrouver ton compte.'
                  : 'Si tu perds ce téléphone, ta phrase de récupération suffit à retrouver ton identité, ton rang et tes abonnements.'
                : 'Ta clé n’existe que sur ce téléphone. Si tu le perds sans avoir noté ta phrase, personne ne pourra te rendre ton compte.'}
            </Txt>
            {!safe && <Button label="Sauvegarder ma phrase" icon="key" onPress={() => router.push('/settings/phrase')} />}
          </View>
        )}

        <Group title="Sauvegardes">
          <Row
            icon="key-outline"
            label="Phrase de récupération"
            detail={safe ? 'Vérifiée' : 'Non vérifiée'}
            right={safe ? <Chip kind="accent" label="OK" /> : undefined}
            onPress={() => router.push('/settings/phrase')}
          />
          {cloudBackupSupported ? (
            <Row
              icon={cloud.saved ? 'cloud-done-outline' : 'cloud-outline'}
              label="Trousseau iCloud"
              detail={
                !cloud.enabled
                  ? 'Désactivé'
                  : cloud.saved
                    ? 'Phrase sauvegardée, chiffrée de bout en bout'
                    : 'Activé · rien à sauvegarder sur cet appareil'
              }
              right={<Switch value={cloud.enabled} onValueChange={toggleCloud} trackColor={{ true: C.accent }} />}
              last
            />
          ) : (
            <Row icon="cloud-outline" label="Sauvegarde Google" detail="Bientôt disponible sur Android" disabled last />
          )}
        </Group>

        <Group
          title="Appareils liés"
          footer="Chaque appareil a sa propre clé, attestée par ton identité. Révoque immédiatement un appareil perdu ou volé.">
          {devices.map((d) => (
            <Row
              key={d.key}
              icon={d.current ? 'phone-portrait' : 'phone-portrait-outline'}
              iconColor={d.revoked ? C.text2 : C.accentText}
              label={d.name}
              detail={d.revoked ? 'Révoqué' : `${d.current ? 'Cet appareil · ' : ''}ajouté le ${date(d.addedAt)}`}
              right={
                d.current ? (
                  <Chip kind="accent" label="ACTUEL" />
                ) : d.revoked ? undefined : (
                  <Txt v="small" color={DANGER} onPress={() => revoke(d.key, d.name)} accessibilityRole="button" style={{ padding: S.sm }}>
                    Révoquer
                  </Txt>
                )
              }
            />
          ))}
          <Row icon="add-circle-outline" label="Lier un appareil" detail="Affiche un QR code à scanner" onPress={() => router.push('/settings/pair')} last />
        </Group>

        {me && (
          <Group title="Identité publique" footer="Ta clé publique t’identifie partout. Elle ne permet pas d’agir en ton nom.">
            <Row icon="finger-print-outline" label={`Empreinte ${me.fingerprint}`} detail={me.key} last />
          </Group>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  status: { gap: S.md, padding: S.lg, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1 },
  statusIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
