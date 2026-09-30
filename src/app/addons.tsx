import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BUILTIN_ID, installAddon, removeAddon, toggleAddon, useAddons } from '@/addons/registry';
import { Button, IconButton, Txt } from '@/components/ui';
import { C, F, R, S } from '@/theme/tokens';

export default function Addons() {
  const insets = useSafeAreaInsets();
  const addons = useAddons();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const add = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await installAddon(url);
      setUrl('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Addon injoignable');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      contentContainerStyle={{ paddingTop: insets.top + S.sm, paddingHorizontal: S.lg, gap: S.xl, paddingBottom: S.xxl }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
        <Txt v="display" style={{ fontSize: 28 }}>Addons</Txt>
      </View>

      <View style={{ gap: S.sm }}>
        <Txt v="small">
          Colle l’URL d’un addon compatible Stremio (manifest.json). Ses sources apparaîtront dans le lecteur.
        </Txt>
        <TextInput
          value={url}
          onChangeText={setUrl}
          onSubmitEditing={add}
          placeholder="https://…/manifest.json"
          placeholderTextColor={C.text2}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          style={styles.input}
        />
        {!!error && <Txt v="small" color="#FF6B6B">{error}</Txt>}
        <Button label={busy ? 'Installation…' : 'Installer'} icon="add" onPress={add} />
      </View>

      <View style={{ gap: S.md }}>
        <Txt v="section">Installés</Txt>
        {addons.map((a) => (
          <View key={a.baseUrl} style={styles.row}>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="label" numberOfLines={1}>{a.manifest.name}</Txt>
              <Txt v="small" numberOfLines={2}>{a.manifest.description ?? a.baseUrl}</Txt>
            </View>
            <Switch value={a.enabled} onValueChange={() => toggleAddon(a.baseUrl)} trackColor={{ true: C.accent }} />
            {a.manifest.id !== BUILTIN_ID && (
              <IconButton
                icon="trash-outline"
                label="Supprimer"
                onPress={() =>
                  Alert.alert(`Supprimer ${a.manifest.name} ?`, undefined, [
                    { text: 'Annuler', style: 'cancel' },
                    { text: 'Supprimer', style: 'destructive', onPress: () => removeAddon(a.baseUrl) },
                  ])
                }
              />
            )}
          </View>
        ))}
      </View>

      <Txt v="small">
        Les flux torrent (infoHash) ne sont pas lisibles sans moteur torrent ; seuls les liens directs HTTP/HLS se lancent dans l’app.
        Huwa ne fournit aucun contenu : n’installe que des addons dont tu as le droit d’utiliser les sources.
      </Txt>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 48, paddingHorizontal: S.lg, borderRadius: R.card, backgroundColor: C.surface,
    color: C.text, ...F.medium, fontSize: 16,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: R.card, backgroundColor: C.surface },
});
