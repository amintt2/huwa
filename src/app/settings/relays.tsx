import { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DANGER, Group, Row, ScreenHeader } from '@/components/social';
import { Button, Txt } from '@/components/ui';
import { bareDiagnostics } from '@/p2p';
import type { RelayStatus } from '@/p2p/bare';
import { addCustomRelay, defaultRelayKeys, relayConfig, setRelayPrefs, useRelayPrefs } from '@/p2p/relays';
import { C, F, R, S } from '@/theme/tokens';

const short = (k: string) => `${k.slice(0, 8)}…${k.slice(-6)}`;

/** Réglages → Sécurité → Relais Huwa. */
export default function Relays() {
  const insets = useSafeAreaInsets();
  const prefs = useRelayPrefs();
  const config = relayConfig(prefs);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<RelayStatus | null>(null);

  useEffect(() => {
    const bare = bareDiagnostics();
    if (!bare) return;
    let alive = true;
    const poll = () =>
      bare.relayStatus().then(
        (s) => alive && setStatus(s),
        () => alive && setStatus(null),
      );
    poll();
    const t = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const add = () => {
    const err = addCustomRelay(draft);
    if (err) Alert.alert('Relais', err);
    else setDraft('');
  };

  const statusDetail = !bareDiagnostics()
    ? 'Réseau P2P indisponible sur cet appareil'
    : !config.enabled
      ? config.keys.length
        ? 'Désactivés'
        : 'Aucun relais configuré'
      : status
        ? `${status.connected}/${status.relays} connecté${status.connected > 1 ? 's' : ''} · ${status.bases + status.cores} élément${status.bases + status.cores > 1 ? 's' : ''} confiés`
        : 'Connexion…';

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <ScreenHeader title="Relais Huwa" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: S.lg, paddingBottom: insets.bottom + S.xxl, gap: S.xl }} keyboardShouldPersistTaps="handled">
        <Group
          footer={
            'Un relais est un pair toujours allumé. Il garde une copie de ton compte (profil, journal, abonnements), de tes conversations en attente et des salons publics que tu ouvres, pour que tout reste disponible quand tes autres appareils sont éteints. ' +
            'C’est lui qui permet de retrouver ton compte avec ta phrase si ton seul téléphone est perdu.'
          }>
          <Row
            icon="cloud-upload-outline"
            label="Utiliser les relais"
            detail={statusDetail}
            right={
              <Switch
                value={prefs.enabled}
                onValueChange={(enabled) => setRelayPrefs((p) => ({ ...p, enabled }))}
                trackColor={{ true: C.accent }}
                accessibilityLabel="Utiliser les relais"
              />
            }
            last
          />
        </Group>

        <Group
          title="Ce que voit un relais"
          footer="Les messages privés restent chiffrés de bout en bout. Les données de ton profil et de ton journal sont publiques sur le réseau Huwa (tout pair peut les lire) : le relais aussi. Il voit l’adresse IP de ta connexion, les clés des espaces qu’il garde et leur taille. Sans activité pendant 120 jours, il les efface.">
          {defaultRelayKeys.map((k, i) => {
            const on = !prefs.disabledDefaults.includes(k);
            return (
              <Row
                key={k}
                icon="server-outline"
                label="Relais Huwa"
                detail={short(k)}
                right={
                  <Switch
                    value={on}
                    onValueChange={(v) =>
                      setRelayPrefs((p) => ({ ...p, disabledDefaults: v ? p.disabledDefaults.filter((x) => x !== k) : [...p.disabledDefaults, k] }))
                    }
                    trackColor={{ true: C.accent }}
                    accessibilityLabel={`Relais Huwa ${short(k)}`}
                  />
                }
                last={i === defaultRelayKeys.length - 1 && prefs.custom.length === 0}
              />
            );
          })}
          {prefs.custom.map((k, i) => (
            <Row
              key={k}
              icon="server-outline"
              label="Relais personnel"
              detail={short(k)}
              right={
                <Txt
                  v="small"
                  color={DANGER}
                  accessibilityRole="button"
                  style={{ padding: S.sm }}
                  onPress={() => setRelayPrefs((p) => ({ ...p, custom: p.custom.filter((x) => x !== k) }))}>
                  Retirer
                </Txt>
              }
              last={i === prefs.custom.length - 1}
            />
          ))}
          {defaultRelayKeys.length + prefs.custom.length === 0 && <Row icon="server-outline" label="Aucun relais" detail="Ajoute la clé d’un relais ci-dessous" disabled last />}
        </Group>

        <Group
          title="Ajouter un relais"
          footer="Tu peux héberger ton propre relais (services/blind-peer du dépôt Huwa) et coller ici la clé publique qu’il affiche au démarrage.">
          <View style={styles.block}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Clé publique du relais"
              placeholderTextColor={C.text2}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={add}
              accessibilityLabel="Clé publique du relais"
              style={styles.input}
            />
            <Button small variant="soft" icon="add" label="Ajouter" onPress={add} />
          </View>
        </Group>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: S.md, padding: S.lg },
  input: {
    minHeight: 44,
    paddingHorizontal: S.md,
    borderRadius: R.control,
    borderCurve: 'continuous',
    backgroundColor: C.elevated,
    borderWidth: 1,
    borderColor: C.border,
    color: C.text,
    ...F.medium,
    fontSize: 15,
  },
});
