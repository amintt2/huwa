import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Chip, IconButton, Press, Txt } from '@/components/ui';
import { PROVIDER_LIST, type DebridId } from '@/debrid/providers';
import { clearDebrid, saveDebridKey, useDebrid } from '@/debrid/store';
import { C, F, R, S } from '@/theme/tokens';

const NOTES: Record<DebridId, string> = {
  torbox: 'Vérifie le cache instantané avant lecture.',
  alldebrid: 'Pas de vérification de cache préalable (supprimée par AllDebrid) : testé à la lecture.',
  premiumize: 'Vérifie le cache instantané avant lecture.',
  realdebrid: 'Pas de vérification de cache (désactivée par Real-Debrid) : testé à la lecture.',
};

export default function Debrid() {
  const insets = useSafeAreaInsets();
  const { provider } = useDebrid();
  const [pick, setPick] = useState<DebridId>(provider?.id ?? 'torbox');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = PROVIDER_LIST.find((p) => p.id === pick)!;

  const save = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await saveDebridKey(pick, key);
      setKey('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Clé refusée');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: insets.top + S.sm, paddingHorizontal: S.lg, gap: S.xl, paddingBottom: S.xxl }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
        <Txt v="display" style={{ fontSize: 28 }}>Débrid</Txt>
      </View>

      <Txt v="small">
        Un service débrid télécharge le torrent sur ses serveurs et te renvoie un lien HTTPS direct : les sources torrent des addons deviennent lisibles dans le lecteur,
        sans rien partager depuis ton téléphone. Abonnement payant chez le fournisseur.
      </Txt>

      {provider && (
        <View style={[styles.card, { borderColor: C.accentLine, backgroundColor: C.accentSoft }]}>
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="label">{provider.name} actif</Txt>
            <Txt v="small">Clé enregistrée dans le trousseau sécurisé de l’appareil.</Txt>
          </View>
          <Button small variant="ghost" icon="trash-outline" label="Retirer"
            onPress={() => Alert.alert(`Retirer ${provider.name} ?`, 'La clé API sera effacée de cet appareil.', [
              { text: 'Annuler', style: 'cancel' },
              { text: 'Retirer', style: 'destructive', onPress: () => clearDebrid() },
            ])} />
        </View>
      )}

      <View style={{ gap: S.sm }}>
        <Txt v="section">Fournisseur</Txt>
        {PROVIDER_LIST.map((p) => {
          const on = p.id === pick;
          return (
            <Press key={p.id} onPress={() => setPick(p.id)} accessibilityRole="radio" accessibilityState={{ selected: on }}
              style={[styles.card, on && { borderColor: C.accentLine }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt v="label">{p.name}</Txt>
                <Txt v="small">{NOTES[p.id]}</Txt>
              </View>
              {provider?.id === p.id && <Chip kind="accent" label="ACTIF" />}
            </Press>
          );
        })}
      </View>

      <View style={{ gap: S.sm }}>
        <Txt v="section">Clé API {current.name}</Txt>
        <TextInput
          value={key}
          onChangeText={setKey}
          onSubmitEditing={save}
          placeholder="Colle ta clé API"
          placeholderTextColor={C.text2}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          textContentType="none"
          returnKeyType="done"
          style={styles.input}
        />
        {!!error && <Txt v="small" color="#FF6B6B">{error}</Txt>}
        <Button label={busy ? 'Vérification…' : 'Vérifier et enregistrer'} icon="shield-checkmark-outline" onPress={save} />
        <Button small variant="ghost" icon="open-outline" label={`Obtenir une clé ${current.name}`} onPress={() => Linking.openURL(current.keyUrl)} />
      </View>

      <Txt v="small">
        La clé n’est envoyée qu’au fournisseur choisi. Les torrents ne sont jamais téléchargés sur l’appareil ; un moteur torrent intégré viendra plus tard.
        Tu restes responsable de la légalité des contenus que tu lis.
      </Txt>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 48, paddingHorizontal: S.lg, borderRadius: R.card, backgroundColor: C.surface,
    color: C.text, ...F.medium, fontSize: 16,
  },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: R.card,
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
});
