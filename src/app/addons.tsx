import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { QUALITIES, type Quality } from '@/addons/quality';
import {
  BUILTIN_ID,
  installAddon,
  moveAddon,
  removeAddon,
  setPrefs,
  toggleAddon,
  useAddonPrefs,
  useAddons,
} from '@/addons/registry';
import { Button, IconButton, Press, Txt } from '@/components/ui';
import { useDebrid } from '@/debrid/store';
import { C, F, R, S } from '@/theme/tokens';

const LEGAL =
  'Huwa ne fournit, n’héberge ni n’indexe aucun contenu. Un addon est un service tiers : tu es seul responsable des sources que tu installes et de leur légalité dans ton pays. ' +
  'N’installe que des addons dont tu as le droit d’utiliser les contenus.';

/** Asks once for the legal acknowledgement; resolves true when accepted. */
const confirmLegal = () =>
  new Promise<boolean>((resolve) =>
    Alert.alert('Avant d’installer un addon', LEGAL, [
      { text: 'Annuler', style: 'cancel', onPress: () => resolve(false) },
      { text: 'J’ai compris', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }),
  );

export default function Addons() {
  const insets = useSafeAreaInsets();
  const addons = useAddons();
  const prefs = useAddonPrefs();
  const { provider } = useDebrid();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const add = async () => {
    if (!url.trim() || busy) return;
    if (!prefs.legalAccepted) {
      if (!(await confirmLegal())) return;
      setPrefs({ legalAccepted: true });
    }
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
          Colle l’URL d’un addon compatible Stremio (manifest.json). Ses sources, catalogues et sous-titres apparaîtront dans l’app.
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

      <View style={{ flexDirection: 'row', gap: S.sm }}>
        <Button style={{ flex: 1 }} small variant="soft" icon="compass-outline" label="Découvrir" onPress={() => router.push('/discover' as Href)} />
        <Button style={{ flex: 1 }} small variant="soft" icon="flash-outline" label={provider ? provider.name : 'Débrid'} onPress={() => router.push('/debrid' as Href)} />
      </View>

      <View style={{ gap: S.md }}>
        <Txt v="section">Installés</Txt>
        <Txt v="small">Ordre = priorité : à qualité égale, les sources du premier addon passent devant.</Txt>
        {addons.map((a, i) => (
          <View key={a.baseUrl} style={styles.row}>
            <View style={{ gap: 2 }}>
              <IconButton icon="chevron-up" label={`Monter ${a.manifest.name}`} size={30} tone="solid" onPress={() => moveAddon(a.baseUrl, -1)} />
              <IconButton icon="chevron-down" label={`Descendre ${a.manifest.name}`} size={30} tone="solid" onPress={() => moveAddon(a.baseUrl, 1)} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="label" numberOfLines={1}>{i + 1}. {a.manifest.name}</Txt>
              <Txt v="small" numberOfLines={2}>{a.manifest.description ?? a.baseUrl}</Txt>
              <Txt v="caption" style={{ fontSize: 10 }} numberOfLines={1}>
                {a.manifest.resources.map((r) => (typeof r === 'string' ? r : r.name)).join(' · ')}
              </Txt>
            </View>
            <Switch value={a.enabled} onValueChange={() => toggleAddon(a.baseUrl)} trackColor={{ true: C.accent }} />
            {a.manifest.id !== BUILTIN_ID && (
              <IconButton
                icon="trash-outline"
                label="Supprimer"
                size={36}
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

      <View style={{ gap: S.md }}>
        <Txt v="section">Qualité préférée</Txt>
        <View style={{ flexDirection: 'row', gap: S.sm, flexWrap: 'wrap' }}>
          {(['auto', ...QUALITIES] as (Quality | 'auto')[]).map((q) => {
            const on = prefs.preferredQuality === q;
            return (
              <Press
                key={q}
                onPress={() => setPrefs({ preferredQuality: q })}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={[styles.qual, on && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
                <Txt v="label" color={on ? C.accentText : C.text} style={{ fontSize: 14 }}>
                  {q === 'auto' ? 'Auto' : q === 2160 ? '4K' : `${q}p`}
                </Txt>
              </Press>
            );
          })}
        </View>
        <Txt v="small">Les flux sont triés par qualité détectée dans leur nom. En cas d’échec de lecture, Huwa passe automatiquement au suivant.</Txt>
      </View>

      <Txt v="small">
        Les flux torrent (infoHash) se lisent via un service débrid (TorBox, AllDebrid, Premiumize, Real-Debrid) configuré dans Débrid.
        {'\n\n'}{LEGAL}
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
  qual: {
    minHeight: 40, minWidth: 64, paddingHorizontal: S.md, alignItems: 'center', justifyContent: 'center',
    borderRadius: R.control, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface,
  },
});
