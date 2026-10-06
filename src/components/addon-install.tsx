// Confirmation sheet shown before installing a Stremio addon, whatever the entry point:
// deep link (`huwa://addon?url=…`, `huwa://install?url=…`), pasted URL or an addon catalog.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { configureAddon } from '@/addons/configure';
import { needsConfiguration, type Manifest } from '@/addons/protocol';
import { installAddon, previewAddon, setPrefs } from '@/addons/registry';
import { Button, Txt } from '@/components/ui';
import { SheetTitle } from './screen';

import { capabilities, hostOf, installedWhat, logoOf, PreviewCard, TrustNote, type PreviewLine } from './extension-ui';
import { C, F, R, S } from '@/theme/tokens';

export { ADDON_LEGAL } from './extension-ui';

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
        <View style={styles.doneIcon}>
          <Ionicons name="checkmark" size={36} color={C.success} />
        </View>
        <Txt v="title" style={{ textAlign: 'center' }}>{m.name} est installée</Txt>
        <Txt v="small" style={{ textAlign: 'center', lineHeight: 19, maxWidth: 320 }}>{installedWhat(m)}</Txt>
        <View style={{ alignSelf: 'stretch', gap: S.sm, marginTop: S.md }}>
          <Button label="Terminé" onPress={closeSheet} />
          <Button small variant="ghost" label="Voir mes extensions" onPress={() => router.replace('/addons' as Href)} />
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.surface }} contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      <View style={{ marginHorizontal: -S.lg, marginTop: -S.lg }}>
        <SheetTitle title="Installer une extension" onClose={closeSheet} />
      </View>

      {!m && !cur.error && (
        <View style={{ alignItems: 'center', gap: S.md, paddingVertical: S.xl }}>
          <ActivityIndicator color={C.accentText} />
          <Txt v="small" numberOfLines={2}>Lecture du manifest…</Txt>
        </View>
      )}

      {!!cur.error && (
        <View style={styles.error}>
          <View style={{ flexDirection: 'row', gap: S.sm, alignItems: 'flex-start' }}>
            <Ionicons name="alert-circle-outline" size={18} color={C.danger} style={{ marginTop: 1 }} />
            <Txt v="label" color={C.danger} style={{ flex: 1 }}>{cur.error}</Txt>
          </View>
          <Txt v="small" selectable numberOfLines={3}>{target}</Txt>
          <Button small variant="soft" icon="refresh" label="Réessayer" onPress={() => setAttempt((n) => n + 1)} />
        </View>
      )}

      {m && (
        <>
          <PreviewCard
            kind="Vidéo · addon Stremio"
            logo={logoOf(m)}
            name={m.name}
            meta={[m.version && `v${m.version}`, hostOf(cur.data!.baseUrl)].filter(Boolean).join(' · ')}
            description={m.description}
            caps={capabilities(m)}
            lines={trustLines(cur.data!, mustConfigure)}
          />
          <TrustNote />

          {mustConfigure ? (
            <Button label={busy === 'configure' ? 'Ouverture…' : 'Configurer sur son site'} icon="settings-outline" onPress={configure} />
          ) : (
            <>
              <Button label={busy === 'install' ? 'Installation…' : cur.data?.existing ? 'Mettre à jour' : 'Installer'} icon="add" onPress={install} />
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

function trustLines(p: Preview, mustConfigure: boolean): PreviewLine[] {
  const lines: PreviewLine[] = [{ icon: 'server-outline', text: `Hébergée par ${hostOf(p.baseUrl)}, pas par Huwa` }];
  if (!resourceCount(p.manifest)) lines.push({ icon: 'layers-outline', text: 'Aucune ressource tant que l’extension n’est pas configurée' });
  if (mustConfigure) lines.push({ icon: 'settings-outline', text: 'À configurer sur son site avant de servir quoi que ce soit', tone: 'warn' });
  if (p.existing) lines.push({ icon: 'refresh-outline', text: 'Déjà installée : cette version remplacera l’actuelle' });
  return lines;
}

const resourceCount = (m: Manifest) => m.resources.length;

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, padding: S.lg, gap: S.lg, paddingBottom: S.xxl, backgroundColor: C.surface },
  doneIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(61,220,151,0.14)' },
  error: { gap: S.md, padding: S.md, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.elevated, borderWidth: 1, borderColor: 'rgba(255,107,107,0.35)' },
  input: {
    minHeight: 44, paddingHorizontal: S.lg, borderRadius: R.card, backgroundColor: C.elevated,
    color: C.text, ...F.medium, fontSize: 15,
  },
});
