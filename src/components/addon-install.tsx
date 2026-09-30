// Confirmation sheet shown before installing a Stremio addon, whatever the entry point:
// deep link (`huwa://addon?url=…`, `huwa://install?url=…`), pasted URL or an addon catalog.
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, type Href } from 'expo-router';
import { useEffect, useState, type ComponentProps } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { configureAddon } from '@/addons/configure';
import { needsConfiguration, resourceNames, type Manifest } from '@/addons/protocol';
import { installAddon, previewAddon, setPrefs } from '@/addons/registry';
import { Button, IconButton, Txt } from '@/components/ui';
import { C, F, R, S } from '@/theme/tokens';

export const ADDON_LEGAL =
  'Huwa ne fournit, n’héberge ni n’indexe aucun contenu, et ne vérifie pas les extensions. Une extension est un service tiers, hébergé par son auteur : ' +
  'tu es seul responsable de celles que tu installes et de la légalité de leurs contenus dans ton pays.';

const RESOURCE_LABEL: Record<string, string> = {
  stream: 'Sources vidéo',
  catalog: 'Catalogues',
  meta: 'Fiches',
  subtitles: 'Sous-titres',
  addon_catalog: 'Catalogue d’extensions',
};

const TYPE_LABEL: Record<string, string> = { series: 'séries', movie: 'films', anime: 'anime', channel: 'chaînes', tv: 'TV', other: 'autres' };

type Preview = { baseUrl: string; manifest: Manifest; existing?: unknown };

/** Closes the sheet; on a cold start from a deep link there is nothing to go back to. */
export function closeSheet() {
  if (router.canGoBack()) router.back();
  else router.replace('/' as Href);
}

export function AddonInstallSheet({ url }: { url: string }) {
  const [target, setTarget] = useState(url);
  const [preview, setPreview] = useState<{ key: string; data?: Preview; error?: string }>({ key: '' });
  const [busy, setBusy] = useState<'' | 'install' | 'configure'>('');
  const [done, setDone] = useState(false);
  const [pasted, setPasted] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}|${target}`;

  useEffect(() => {
    let cancelled = false;
    previewAddon(target)
      .then((data) => !cancelled && setPreview({ key, data }))
      .catch((e) => !cancelled && setPreview({ key, error: e instanceof Error ? e.message : 'Addon injoignable' }));
    return () => {
      cancelled = true;
    };
  }, [key, target]);

  const cur = preview.key === key ? preview : { data: undefined, error: undefined };
  const m = cur.data?.manifest;
  const mustConfigure = !!m && needsConfiguration(m);

  const install = async () => {
    if (!cur.data || busy) return;
    setBusy('install');
    try {
      setPrefs({ legalAccepted: true });
      await installAddon(cur.data.baseUrl, cur.data.manifest);
      setDone(true);
    } catch (e) {
      setPreview({ key, error: e instanceof Error ? e.message : 'Échec' });
    } finally {
      setBusy('');
    }
  };

  const configure = async () => {
    if (!cur.data || busy) return;
    setBusy('configure');
    try {
      const configured = await configureAddon(cur.data.baseUrl);
      if (configured) setTarget(configured);
      else setPasteOpen(true);
    } finally {
      setBusy('');
    }
  };

  if (done && m) {
    return (
      <View style={[styles.wrap, { alignItems: 'center', justifyContent: 'center' }]}>
        <Ionicons name="checkmark-circle" size={56} color={C.success} />
        <Txt v="title" style={{ textAlign: 'center' }}>{m.name} est installé</Txt>
        <Txt v="small" style={{ textAlign: 'center' }}>Ses sources apparaissent dans le menu Sources de chaque épisode, ses catalogues dans Découvrir.</Txt>
        <Button label="Terminé" onPress={closeSheet} />
        <Button small variant="ghost" label="Voir mes extensions" onPress={() => router.replace('/addons' as Href)} />
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.surface }} contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Txt v="section" style={{ flex: 1 }}>Ajouter une extension</Txt>
        <IconButton icon="close" label="Fermer" onPress={closeSheet} />
      </View>

      {!m && !cur.error && (
        <View style={{ alignItems: 'center', gap: S.md, paddingVertical: S.xl }}>
          <ActivityIndicator color={C.accentText} />
          <Txt v="small" numberOfLines={2}>Lecture du manifest…</Txt>
        </View>
      )}

      {!!cur.error && (
        <View style={{ gap: S.md }}>
          <Txt v="label" color="#FF6B6B">{cur.error}</Txt>
          <Txt v="small" selectable>{target}</Txt>
          <Button small variant="soft" icon="refresh" label="Réessayer" onPress={() => setAttempt((n) => n + 1)} />
        </View>
      )}

      {m && (
        <>
          <View style={styles.head}>
            {m.logo ? <Image source={{ uri: m.logo }} style={styles.logo} contentFit="contain" /> : (
              <View style={[styles.logo, { alignItems: 'center', justifyContent: 'center' }]}>
                <Ionicons name="extension-puzzle-outline" size={28} color={C.accentText} />
              </View>
            )}
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="title" numberOfLines={2}>{m.name}</Txt>
              <Txt v="small">{[m.version && `v${m.version}`, hostOf(cur.data!.baseUrl)].filter(Boolean).join(' · ')}</Txt>
            </View>
          </View>
          {!!m.description && <Txt v="body" numberOfLines={8}>{m.description}</Txt>}

          <View style={styles.box}>
            <Line icon="layers-outline" text={resourceNames(m).map((r) => RESOURCE_LABEL[r] ?? r).join(' · ') || 'Aucune ressource tant que l’extension n’est pas configurée'} />
            {!!m.types?.length && <Line icon="film-outline" text={`Types : ${m.types.map((t) => TYPE_LABEL[t] ?? t).join(', ')}`} />}
            {!!m.catalogs?.length && <Line icon="grid-outline" text={`${m.catalogs.length} catalogue${m.catalogs.length > 1 ? 's' : ''}`} />}
            <Line icon="server-outline" text={`Hébergée par ${hostOf(cur.data!.baseUrl)}, pas par Huwa`} />
            {m.behaviorHints?.p2p && <Line icon="git-network-outline" text="Utilise le pair-à-pair (torrent)" />}
            {m.behaviorHints?.adult && <Line icon="warning-outline" text="Contenu réservé aux adultes" />}
            {!!cur.data?.existing && <Line icon="refresh-outline" text="Déjà installée : cette version remplacera l’actuelle" />}
          </View>

          <View style={[styles.box, { borderColor: 'rgba(255,196,0,0.35)' }]}>
            <Txt v="small" style={{ lineHeight: 18 }}>{ADDON_LEGAL}</Txt>
          </View>

          {mustConfigure ? (
            <>
              <Txt v="small">Cette extension doit être configurée sur son site avant de servir quoi que ce soit.</Txt>
              <Button label={busy === 'configure' ? 'Ouverture…' : 'Configurer sur son site'} icon="settings-outline" onPress={configure} />
            </>
          ) : (
            <>
              <Button label={busy === 'install' ? 'Installation…' : 'J’ai compris, installer'} icon="add" onPress={install} />
              {m.behaviorHints?.configurable && (
                <Button small variant="soft" icon="settings-outline" label={busy === 'configure' ? 'Ouverture…' : 'Configurer d’abord'} onPress={configure} />
              )}
            </>
          )}
          {(pasteOpen || m.behaviorHints?.configurable) && (
            <View style={{ gap: S.sm }}>
              <Txt v="small">Le site affiche un lien au lieu de revenir dans Huwa ? Copie-le et colle-le ici :</Txt>
              <TextInput
                value={pasted}
                onChangeText={setPasted}
                placeholder="stremio://…/manifest.json"
                placeholderTextColor={C.text2}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                onSubmitEditing={() => pasted.trim() && setTarget(pasted.trim())}
                style={styles.input}
              />
              {!!pasted.trim() && <Button small variant="soft" label="Utiliser ce lien" onPress={() => setTarget(pasted.trim())} />}
            </View>
          )}
          <Button small variant="ghost" label="Annuler" onPress={closeSheet} />
        </>
      )}
    </ScrollView>
  );
}

function Line({ icon, text }: { icon: ComponentProps<typeof Ionicons>['name']; text: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: S.sm, alignItems: 'flex-start' }}>
      <Ionicons name={icon} size={16} color={C.accentText} style={{ marginTop: 1 }} />
      <Txt v="small" style={{ flex: 1, color: C.body }}>{text}</Txt>
    </View>
  );
}

const hostOf = (u: string) => {
  const m = /^https?:\/\/([^/]+)/i.exec(u);
  return m ? m[1] : u;
};

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, padding: S.lg, gap: S.lg, paddingBottom: S.xxl, backgroundColor: C.surface },
  head: { flexDirection: 'row', alignItems: 'center', gap: S.md },
  logo: { width: 56, height: 56, borderRadius: 14, backgroundColor: C.elevated },
  box: { gap: S.sm, padding: S.md, borderRadius: R.card, backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border },
  input: {
    minHeight: 44, paddingHorizontal: S.lg, borderRadius: R.card, backgroundColor: C.elevated,
    color: C.text, ...F.medium, fontSize: 15,
  },
});
