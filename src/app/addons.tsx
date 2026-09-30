// "Extensions": every source the user adds himself. Huwa ships none.
//  - Vidéo: Stremio-compatible addons (streams, catalogs, subtitles, addon catalogs).
//  - Manhwa: Paperback repositories, managed by `/manga-extensions`.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { configureAddon } from '@/addons/configure';
import { hasResource, resourceNames } from '@/addons/protocol';
import { QUALITIES, type Quality } from '@/addons/quality';
import {
  BUILTIN_ID,
  moveAddon,
  refreshAddon,
  removeAddon,
  setPrefs,
  toggleAddon,
  useAddonPrefs,
  useAddons,
} from '@/addons/registry';
import { ADDON_LEGAL } from '@/components/addon-install';
import { Group, Row } from '@/components/states';
import { Button, IconButton, Press, Txt } from '@/components/ui';
import { useDebrid } from '@/debrid/store';
import { C, F, R, S } from '@/theme/tokens';

const EXTENSIONS_SITE = 'https://huwa.mciut.fr/extensions';

const openInstall = (url: string) => router.push({ pathname: '/addon', params: { url } } as unknown as Href);

export default function Extensions() {
  const insets = useSafeAreaInsets();
  const addons = useAddons();
  const prefs = useAddonPrefs();
  const { provider } = useDebrid();
  const [url, setUrl] = useState('');
  const catalogs = addons.filter((a) => a.enabled && hasResource(a.manifest, 'addon_catalog'))
    .flatMap((a) => (a.manifest.addonCatalogs ?? []).map((c) => ({ a, c })));

  const add = () => {
    if (!url.trim()) return;
    openInstall(url.trim());
    setUrl('');
  };

  const reconfigure = async (baseUrl: string) => {
    const configured = await configureAddon(baseUrl).catch(() => null);
    if (configured) openInstall(configured);
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: insets.top + S.sm, paddingHorizontal: S.lg, gap: S.xl, paddingBottom: S.xxl + insets.bottom }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
        <Txt v="display" style={{ fontSize: 28 }}>Extensions</Txt>
      </View>

      <Txt v="small">
        Huwa est une bibliothèque : il ne fournit aucun contenu, et à part la démo (vidéos libres de droits, désactivable) aucune extension n’est préinstallée. Tu ajoutes celles que tu veux, hébergées par leurs auteurs.
      </Txt>

      {/* ---------- Vidéo ---------- */}
      <View style={{ gap: S.sm }}>
        <Txt v="section">Vidéo · addons Stremio</Txt>
        <Txt v="small">
          Colle le lien d’un addon compatible Stremio (manifest.json, stremio://… ou lien web.stremio.com). Ses sources, catalogues et sous-titres apparaîtront dans l’app.
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
          accessibilityLabel="Lien de l’addon"
        />
        <Button label="Ajouter" icon="add" onPress={add} />
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
              <Txt v="caption" style={{ fontSize: 10 }} numberOfLines={1}>{resourceNames(a.manifest).join(' · ')}</Txt>
            </View>
            <Switch value={a.enabled} onValueChange={() => toggleAddon(a.baseUrl)} trackColor={{ true: C.accent }} />
            {a.manifest.id !== BUILTIN_ID && (
              <IconButton
                icon="ellipsis-horizontal"
                label={`Options de ${a.manifest.name}`}
                size={36}
                onPress={() =>
                  Alert.alert(a.manifest.name, a.baseUrl, [
                    ...(a.manifest.behaviorHints?.configurable ? [{ text: 'Reconfigurer', onPress: () => reconfigure(a.baseUrl) }] : []),
                    { text: 'Mettre à jour le manifest', onPress: () => refreshAddon(a.baseUrl).catch((e) => Alert.alert('Échec', e instanceof Error ? e.message : String(e))) },
                    { text: 'Supprimer', style: 'destructive' as const, onPress: () => removeAddon(a.baseUrl) },
                    { text: 'Annuler', style: 'cancel' as const },
                  ])
                }
              />
            )}
          </View>
        ))}
      </View>

      {catalogs.length > 0 && (
        <Group title="CATALOGUES D’EXTENSIONS (FOURNIS PAR TES ADDONS)">
          {catalogs.map(({ a, c }, i) => (
            <Row
              key={`${a.baseUrl}|${c.type}|${c.id}`}
              icon="albums-outline"
              label={`${c.name ?? c.id} · ${c.type}`}
              hint={a.manifest.name}
              last={i === catalogs.length - 1}
              onPress={() => router.push({ pathname: '/addon-catalog', params: { addon: a.baseUrl, type: c.type, id: c.id, name: c.name ?? c.id } } as unknown as Href)}
            />
          ))}
        </Group>
      )}

      {/* ---------- Manhwa ---------- */}
      <Group title="MANHWA">
        <Row
          icon="book-outline"
          label="Extensions manhwa (dépôts Paperback)"
          hint="Ajoute un dépôt compatible Paperback pour lire les chapitres."
          last
          onPress={() => router.push('/manga-extensions' as Href)}
        />
      </Group>

      <Group title="BIBLIOTHÈQUE">
        <Row
          icon="download-outline"
          label="Importer depuis Stremio ou anime-sama"
          hint="Reprends ta liste et tes addons sans repartir de zéro."
          last
          onPress={() => router.push('/import' as Href)}
        />
      </Group>

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

      <Press onPress={() => WebBrowser.openBrowserAsync(EXTENSIONS_SITE)} style={styles.site} accessibilityRole="link">
        <Ionicons name="globe-outline" size={20} color={C.accentText} />
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="label">Ajouter des extensions en 1 clic</Txt>
          <Txt v="small">huwa.mciut.fr/extensions : génère un bouton « Ajouter à Huwa » et un QR code pour n’importe quel addon.</Txt>
        </View>
        <Ionicons name="open-outline" size={16} color={C.text2} />
      </Press>

      <Txt v="small">
        Les flux torrent (infoHash) se lisent via un service débrid (TorBox, AllDebrid, Premiumize, Real-Debrid) configuré dans Débrid.
        {'\n\n'}{ADDON_LEGAL}
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
  site: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: R.card, backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentLine },
  qual: {
    minHeight: 40, minWidth: 64, paddingHorizontal: S.md, alignItems: 'center', justifyContent: 'center',
    borderRadius: R.control, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface,
  },
});
