// Réglages → Serveur de streaming (docs/WEB_DOCKER_PLAN.md P1, D10, D12).
// Shows the server this browser uses (own choice, instance default or none), what it can do (a
// badge from its /api/v1/info or Stremio /settings), and lets the user change, test or remove it.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Field, Group } from '@/components/social';
import { Button, Txt } from '@/components/ui';
import { C, F, R, S } from '@/theme/tokens';

import { cleanUrl, useWebConfig } from './config';
import { mixedContent, resetStreamingServer, setStreamingServer, useServerProbe, useStreamingServer, type Probe } from './streaming-server';

const SOURCE_LABEL = { user: 'Ton choix', instance: 'Serveur de l’instance', none: 'Aucun' } as const;

export function StreamingServerSettings() {
  const choice = useStreamingServer();
  const config = useWebConfig();
  const [attempt, setAttempt] = useState(0);
  const probe = useServerProbe(choice.url, attempt);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();

  const save = () => {
    const url = cleanUrl(text);
    if (!url) return setError('Adresse invalide : elle doit commencer par https:// (ou http:// pour localhost).');
    try {
      setStreamingServer(url);
      setEditing(false);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Adresse invalide.');
    }
  };

  return (
    <Group
      title="Serveur de streaming"
      footer="Le serveur de streaming lit les torrents et convertit les vidéos que ton navigateur ne sait pas lire. Il voit ce que tu regardes : choisis le tien, ou celui de quelqu’un de confiance.">
      <View style={styles.box}>
        <View style={styles.head}>
          <View style={styles.icon}>
            <Ionicons name="server-outline" size={18} color={C.accentText} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="label" numberOfLines={1} selectable>{choice.url ?? 'Aucun serveur'}</Txt>
            <Txt v="small">{SOURCE_LABEL[choice.source]}</Txt>
          </View>
          {choice.url && <Badge probe={probe} />}
        </View>

        {choice.url && probe?.state === 'ok' && probe.features.length > 0 && (
          <View style={styles.chips}>
            {probe.features.map((f) => (
              <View key={f} style={styles.chip}>
                <Txt v="footnote" color={C.body} style={F.semibold}>{f}</Txt>
              </View>
            ))}
          </View>
        )}
        {choice.url && probe?.state === 'error' && <Txt v="small" color={C.text2}>{probeHelp(probe, choice.url)}</Txt>}
        {!choice.url && (
          <Txt v="small">Sans serveur, Huwa lit les liens directs de tes extensions (HTTP, debrid). Les torrents et les formats non pris en charge par ton navigateur demandent un serveur.</Txt>
        )}

        {editing ? (
          <View style={{ gap: S.sm }}>
            <Field
              value={text}
              onChangeText={(t) => {
                setText(t);
                setError(undefined);
              }}
              placeholder="https://huwa.example.org"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              autoFocus
              onSubmitEditing={save}
              error={error}
              accessibilityLabel="Adresse du serveur de streaming"
            />
            <View style={styles.row}>
              <Button small variant="ghost" label="Annuler" onPress={() => setEditing(false)} />
              <Button small label="Enregistrer" icon="checkmark" onPress={save} />
            </View>
          </View>
        ) : (
          <View style={styles.row}>
            <Button
              small
              variant="soft"
              icon="create-outline"
              label={choice.url ? 'Changer' : 'Ajouter un serveur'}
              onPress={() => {
                setText(choice.url ?? '');
                setEditing(true);
              }}
            />
            {choice.url && <Button small variant="ghost" icon="refresh" label="Tester" onPress={() => setAttempt((n) => n + 1)} />}
            {choice.url && <Button small variant="plain" label="Retirer" onPress={() => setStreamingServer(null)} />}
            {choice.source !== 'instance' && config.defaultStreamingServer && (
              <Button small variant="plain" label="Serveur de l’instance" onPress={resetStreamingServer} />
            )}
          </View>
        )}
      </View>
    </Group>
  );
}

function probeHelp(p: Extract<Probe, { state: 'error' }>, url: string) {
  if (p.reason === 'mixed' || mixedContent(url)) return 'Ce serveur est en http:// : ton navigateur bloque ses vidéos sur une page en https://. Utilise son adresse en https://.';
  if (p.reason === 'unknown') return 'Le serveur répond, mais ce n’est ni un Huwa Server ni un serveur Stremio.';
  return 'Injoignable : vérifie l’adresse, que le serveur tourne, et qu’il autorise ce site (HUWA_ALLOWED_ORIGINS).';
}

function Badge({ probe }: { probe: Probe | null }) {
  if (!probe || probe.state === 'checking') {
    return (
      <View style={[styles.badge, { borderColor: C.border }]}>
        <ActivityIndicator size="small" color={C.text2} />
        <Txt v="footnote">Test…</Txt>
      </View>
    );
  }
  if (probe.state === 'error') {
    return (
      <View style={[styles.badge, { borderColor: 'rgba(255,122,122,0.4)', backgroundColor: 'rgba(255,122,122,0.10)' }]} accessibilityLabel="Serveur injoignable">
        <Ionicons name="alert-circle" size={14} color={C.danger} />
        <Txt v="footnote" color={C.danger} style={F.semibold}>{probe.reason === 'mixed' ? 'Bloqué (http)' : probe.reason === 'unknown' ? 'Inconnu' : 'Injoignable'}</Txt>
      </View>
    );
  }
  return (
    <View style={[styles.badge, { borderColor: 'rgba(61,220,151,0.4)', backgroundColor: 'rgba(61,220,151,0.10)' }]} accessibilityLabel={`${probe.name} ${probe.version ?? ''}`}>
      <Ionicons name="checkmark-circle" size={14} color={C.success} />
      <Txt v="footnote" color={C.success} style={F.semibold}>
        {probe.name}
        {probe.version ? ` ${probe.version}` : ''}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { padding: S.lg, gap: S.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: S.md },
  icon: { width: 36, height: 36, borderRadius: 10, backgroundColor: C.accentSoft, alignItems: 'center', justifyContent: 'center' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingHorizontal: 9, borderRadius: R.pill, borderWidth: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: R.chip, backgroundColor: C.pill, borderWidth: 1, borderColor: C.pillLine },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm, alignItems: 'center' },
});
