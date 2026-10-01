// Detail of an installed video extension (Stremio addon): `/extension?url=<baseUrl>`.
// Identity, capabilities, catalogs, enable / priority, configure, update, share, remove.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { configureAddon } from '@/addons/configure';
import { huwaInstallLink, needsConfiguration } from '@/addons/protocol';
import { BUILTIN_ID, moveAddon, refreshAddon, removeAddon, toggleAddon, useAddons } from '@/addons/registry';
import { capabilities, CapChips, Card, ExtLogo, hostOf, LinkRow, logoOf, TrustNote } from '@/components/extension-ui';
import { Empty } from '@/components/social';
import { Button, IconButton, Press, Txt } from '@/components/ui';
import { C, F, R, S } from '@/theme/tokens';

const TYPE_LABEL: Record<string, string> = { series: 'Séries', movie: 'Films', anime: 'Anime', channel: 'Chaînes', tv: 'TV', other: 'Autres' };

export default function ExtensionDetail() {
  const insets = useSafeAreaInsets();
  const { url } = useLocalSearchParams<{ url?: string }>();
  const addons = useAddons();
  const index = addons.findIndex((a) => a.baseUrl === url);
  const a = addons[index];
  const [busy, setBusy] = useState<'' | 'refresh' | 'configure'>('');

  const header = (
    <View style={[styles.top, { paddingTop: insets.top + S.sm }]}>
      <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
    </View>
  );

  if (!a) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {header}
        <Empty icon="extension-puzzle-outline" title="Extension introuvable" text="Elle a peut-être été supprimée." action={<Button small label="Mes extensions" onPress={() => router.replace('/addons' as Href)} />} />
      </View>
    );
  }

  const m = a.manifest;
  const builtin = m.id === BUILTIN_ID;
  const host = builtin ? 'intégrée à Huwa' : hostOf(a.baseUrl);
  const configurable = !builtin && (m.behaviorHints?.configurable || needsConfiguration(m));

  const reconfigure = async () => {
    setBusy('configure');
    try {
      const configured = await configureAddon(a.baseUrl).catch(() => null);
      if (configured) router.push({ pathname: '/addon', params: { url: configured } } as unknown as Href);
    } finally {
      setBusy('');
    }
  };

  const refresh = async () => {
    setBusy('refresh');
    try {
      await refreshAddon(a.baseUrl);
    } catch (e) {
      Alert.alert('Mise à jour impossible', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const remove = () =>
    Alert.alert(`Supprimer ${m.name} ?`, 'Ses sources, catalogues et sous-titres disparaîtront de l’app. Tu pourras la réinstaller avec son lien.', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Supprimer',
        style: 'destructive',
        onPress: () => {
          removeAddon(a.baseUrl);
          router.back();
        },
      },
    ]);

  const catalogs = m.catalogs ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + S.xxl }}>
        {header}
        <View style={styles.wrap}>
          <View style={styles.hero}>
            <ExtLogo uri={logoOf(m)} name={m.name} size={72} icon={builtin ? 'play-circle-outline' : undefined} />
            <View style={{ flex: 1, gap: 3 }}>
              <Txt v="caption" color={C.accentText} style={{ fontSize: 10 }}>Vidéo · addon Stremio</Txt>
              <Txt v="title" numberOfLines={3}>{m.name}</Txt>
              <Txt v="small" numberOfLines={1}>{[m.version && `v${m.version}`, host].filter(Boolean).join(' · ')}</Txt>
            </View>
          </View>
          {!!m.description && <Txt v="body" style={{ color: C.body }}>{m.description}</Txt>}
          <CapChips caps={capabilities(m)} />

          <Card>
            <View style={[styles.row, addons.length > 1 && styles.line]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt v="label">Activée</Txt>
                <Txt v="small">{a.enabled ? 'Ses sources et catalogues sont utilisés.' : 'Mise en pause : rien n’est demandé à cette extension.'}</Txt>
              </View>
              <Switch value={a.enabled} onValueChange={() => toggleAddon(a.baseUrl)} trackColor={{ true: C.accent }} accessibilityLabel={`Activer ${m.name}`} />
            </View>
            {addons.length > 1 && (
            <View style={styles.row}>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt v="label">Priorité {index + 1} sur {addons.length}</Txt>
                <Txt v="small">À qualité égale, ses sources passent avant celles des suivantes.</Txt>
              </View>
              <View style={{ flexDirection: 'row', gap: S.sm }}>
                <IconButton icon="arrow-up" label="Monter en priorité" size={36} tone="solid" color={index === 0 ? C.text2 : C.text} onPress={() => moveAddon(a.baseUrl, -1)} />
                <IconButton icon="arrow-down" label="Descendre en priorité" size={36} tone="solid" color={index === addons.length - 1 ? C.text2 : C.text} onPress={() => moveAddon(a.baseUrl, 1)} />
              </View>
            </View>
            )}
          </Card>

          {catalogs.length > 0 && (
            <View style={{ gap: S.sm }}>
              <Txt v="caption" style={{ paddingHorizontal: S.xs }}>Catalogues ({catalogs.length})</Txt>
              <Card>
                {catalogs.map((c, i) => (
                  <View key={`${c.type}|${c.id}`} style={[styles.row, { minHeight: 48 }, i < catalogs.length - 1 && styles.line]}>
                    <Ionicons name="grid-outline" size={16} color={C.accentText} />
                    <Txt v="label" numberOfLines={1} style={{ flex: 1, fontSize: 14 }}>{c.name ?? c.id}</Txt>
                    <Txt v="small" style={{ fontSize: 12 }}>{TYPE_LABEL[c.type] ?? c.type}</Txt>
                  </View>
                ))}
              </Card>
              <Txt v="small" style={{ paddingHorizontal: S.xs }}>Ils apparaissent dans Découvrir.</Txt>
            </View>
          )}

          {!builtin && (
            <Card>
              {configurable && (
                <LinkRow icon="settings-outline" label={busy === 'configure' ? 'Ouverture…' : 'Configurer'} hint="Ouvre sa page de réglages ; la nouvelle configuration remplace l’actuelle." onPress={reconfigure} />
              )}
              <LinkRow icon="refresh-outline" label={busy === 'refresh' ? 'Mise à jour…' : 'Mettre à jour le manifest'} hint="Relit ses catalogues et sa version." onPress={refresh} />
              <LinkRow icon="albums-outline" label="Partager dans un pack" hint="Un lien et un QR pour installer tes extensions en un geste." onPress={() => router.push('/pack-create' as Href)} />
              <LinkRow
                icon="share-outline"
                label="Partager le lien d’installation"
                last
                onPress={() => Share.share({ message: huwaInstallLink(a.baseUrl) }).catch(() => {})}
              />
            </Card>
          )}

          {!builtin && <TrustNote text={`Service tiers hébergé par ${host}. Huwa ne vérifie pas son contenu.`} />}

          {!builtin ? (
            <Press onPress={remove} accessibilityRole="button" accessibilityLabel={`Supprimer ${m.name}`} style={styles.danger}>
              <Ionicons name="trash-outline" size={16} color="#FF6B6B" />
              <Txt v="label" color="#FF6B6B" style={F.semibold}>Supprimer l’extension</Txt>
            </Press>
          ) : (
            <Txt v="small" style={{ lineHeight: 18 }}>Flux de démonstration libres de droits, fournis avec Huwa. Désactive-la quand tu as tes propres extensions.</Txt>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { paddingHorizontal: S.lg, paddingBottom: S.sm, flexDirection: 'row' },
  wrap: { paddingHorizontal: S.lg, gap: S.lg },
  hero: { flexDirection: 'row', alignItems: 'center', gap: S.lg, paddingTop: S.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md },
  line: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.borderStrong },
  danger: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm, minHeight: 50, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: 'rgba(255,107,107,0.10)', borderWidth: 1, borderColor: 'rgba(255,107,107,0.30)',
  },
});
