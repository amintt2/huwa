// "Ajouter une extension": one field that takes any link (Stremio manifest, stremio://,
// web.stremio.com, Paperback repository or paperback://addRepo, Huwa pack, huwa:// and site
// links), recognizes it and previews it before anything is installed. Nothing installs on its
// own: video addons install from here after a tap, Paperback repositories and packs continue on
// their own confirmation screens.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hasResource, needsConfiguration, type Manifest } from '@/addons/protocol';
import { EXTENSIONS_SITE } from '@/addons/recommended';
import { installAddon, previewAddon, setPrefs, useAddons } from '@/addons/registry';
import { closeSheet } from '@/components/addon-install';
import { capabilities, Card, hostOf, installedWhat, LinkRow, logoOf, PreviewCard, TrustNote, type PreviewLine } from '@/components/extension-ui';
import { Scanner } from '@/components/link-prompt';
import { RecommendedExtensions } from '@/components/recommended-extensions';
import { SheetTitle } from '@/components/screen';
import { Button, Press, Txt } from '@/components/ui';
import { fetchRepo, type RepoEntry } from '@/manga-ext/registry';
import { classifyLink, type Pack, type PastedLink } from '@/packs/format';
import { loadPack } from '@/packs/install';
import { hrefFor } from '@/packs/routes';
import { C, F, R, S } from '@/theme/tokens';

type Found =
  | { kind: 'addon'; link: PastedLink; baseUrl: string; manifest: Manifest; existing: boolean }
  | { kind: 'paperback'; link: PastedLink; repo: RepoEntry }
  | { kind: 'pack'; link: PastedLink; pack: Pack };

type Detect = { input: string; state: 'idle' | 'checking' | 'invalid' | 'error' | 'found'; found?: Found; error?: string; kind?: PastedLink['kind'] };

const KIND_LABEL: Record<PastedLink['kind'], string> = { addon: 'Addon Stremio', paperback: 'Dépôt Paperback', pack: 'Pack d’extensions' };

const packHost = (link: PastedLink) => (link.kind === 'pack' && 'url' in link.ref ? hostOf(link.ref.url) : undefined);

async function inspect(link: PastedLink): Promise<Found> {
  if (link.kind === 'addon') {
    const p = await previewAddon(link.url);
    return { kind: 'addon', link, baseUrl: p.baseUrl, manifest: p.manifest, existing: !!p.existing };
  }
  if (link.kind === 'paperback') return { kind: 'paperback', link, repo: await fetchRepo(link.url) };
  return { kind: 'pack', link, pack: await loadPack(link.ref) };
}

export default function ExtensionAdd() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ kind?: string; url?: string }>();
  const manga = params.kind === 'manga';
  const [text, setText] = useState(params.url ? String(params.url) : '');
  const [detect, setDetect] = useState<Detect>({ input: '', state: 'idle' });
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [installed, setInstalled] = useState<{ name: string; baseUrl: string; what: string } | null>(null);
  const addons = useAddons();

  // Live recognition, 450 ms after the last keystroke.
  useEffect(() => {
    const input = `${attempt}|${text.trim()}`;
    if (!text.trim()) return;
    const link = classifyLink(text);
    let cancelled = false;
    const timer = setTimeout(
      () => {
        if (!link) return setDetect({ input, state: 'invalid' });
        setDetect({ input, state: 'checking' });
        inspect(link)
          .then((found) => !cancelled && setDetect({ input, state: 'found', found }))
          .catch((e) => !cancelled && setDetect({ input, state: 'error', kind: link.kind, error: e instanceof Error ? e.message : 'Lien injoignable' }));
      },
      link ? 450 : 900,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, attempt]);

  const cur: Detect = text.trim() && detect.input === `${attempt}|${text.trim()}` ? detect : { input: '', state: text.trim() ? 'checking' : 'idle' };
  const found = cur.state === 'found' ? cur.found : undefined;

  const install = async () => {
    if (found?.kind !== 'addon' || busy) return;
    setBusy(true);
    try {
      setPrefs({ legalAccepted: true });
      await installAddon(found.baseUrl, found.manifest);
      setInstalled({ name: found.manifest.name, baseUrl: found.baseUrl, what: installedWhat(found.manifest) });
    } catch (e) {
      Alert.alert('Installation impossible', e instanceof Error ? e.message : 'Extension injoignable');
    } finally {
      setBusy(false);
    }
  };

  /** Leaves the sheet for the link's own confirmation screen. */
  const continueWith = (link: PastedLink) => router.replace(hrefFor(link));

  const directory = addons
    .filter((a) => a.enabled && hasResource(a.manifest, 'addon_catalog'))
    .flatMap((a) => (a.manifest.addonCatalogs ?? []).map((c) => ({ a, c })))[0];
  const openDirectory = () => {
    if (!directory) {
      Alert.alert('Catalogue Stremio', 'Ajoute d’abord Cinemeta (dans « Recommandées » ci-dessous) : il donne accès à l’annuaire des addons publics.');
      return;
    }
    router.replace({ pathname: '/addon-catalog', params: { addon: directory.a.baseUrl, type: directory.c.type, id: directory.c.id, name: directory.c.name ?? directory.c.id } } as unknown as Href);
  };

  if (installed) {
    return (
      <View style={[styles.screen, styles.center, { paddingBottom: insets.bottom + S.xl }]}>
        <View style={styles.doneIcon}>
          <Ionicons name="checkmark" size={36} color={C.success} />
        </View>
        <Txt v="title" style={{ textAlign: 'center' }}>{installed.name} est installée</Txt>
        <Txt v="small" style={{ textAlign: 'center', lineHeight: 19, maxWidth: 320 }}>
          {installed.what}
        </Txt>
        <View style={{ alignSelf: 'stretch', gap: S.sm, marginTop: S.md }}>
          <Button label="Terminé" onPress={closeSheet} />
          <Button small variant="ghost" label="Voir l’extension" onPress={() => router.replace({ pathname: '/extension', params: { url: installed.baseUrl } } as unknown as Href)} />
          <Button small variant="ghost" label="En ajouter une autre" onPress={() => { setInstalled(null); setText(''); }} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={[styles.wrap, { paddingBottom: insets.bottom + S.xxl }]} keyboardShouldPersistTaps="handled">
        <View style={{ marginHorizontal: -S.lg, marginTop: -S.lg }}>
          <SheetTitle title="Ajouter une extension" onClose={closeSheet} />
        </View>
        <Txt v="small" style={{ lineHeight: 19, marginTop: -S.sm }}>
          Colle n’importe quel lien : addon Stremio, dépôt Paperback ou pack d’extensions. Huwa reconnaît ce que c’est et te le montre avant d’installer.
        </Txt>

        <View style={[styles.field, cur.state === 'found' && { borderColor: C.accentLine }]}>
          <Ionicons name="link-outline" size={18} color={C.text2} />
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={manga ? 'https://…/versioning.json ou paperback://…' : 'https://…/manifest.json, stremio://…'}
            placeholderTextColor="#6F7A90"
            selectionColor={C.accentText}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            keyboardAppearance="dark"
            returnKeyType="done"
            accessibilityLabel="Lien de l’extension"
            style={styles.input}
          />
          {text ? (
            <Press onPress={() => setText('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Effacer le lien">
              <Ionicons name="close-circle" size={18} color={C.text2} />
            </Press>
          ) : (
            <Press onPress={() => setScanning(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Scanner un QR code">
              <Ionicons name="qr-code-outline" size={20} color={C.accentText} />
            </Press>
          )}
        </View>

        {cur.state === 'checking' && (
          <View style={styles.status}>
            <ActivityIndicator color={C.accentText} />
            <Txt v="small">Vérification du lien…</Txt>
          </View>
        )}
        {cur.state === 'invalid' && (
          <View style={styles.status}>
            <Ionicons name="help-circle-outline" size={18} color={C.text2} />
            <Txt v="small" style={{ flex: 1 }}>Ce lien n’est ni un addon Stremio, ni un dépôt Paperback, ni un pack Huwa.</Txt>
          </View>
        )}
        {cur.state === 'error' && (
          <View style={[styles.status, { borderColor: 'rgba(255,107,107,0.35)' }]}>
            <Ionicons name="alert-circle-outline" size={18} color="#FF8A8A" />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="label" color="#FF8A8A" style={{ fontSize: 14 }}>{cur.kind ? `${KIND_LABEL[cur.kind]} injoignable` : 'Lien injoignable'}</Txt>
              <Txt v="small" numberOfLines={3}>{cur.error}</Txt>
            </View>
            <Press onPress={() => setAttempt((n) => n + 1)} hitSlop={8} accessibilityRole="button">
              <Txt v="small" color={C.accentText} style={F.semibold}>Réessayer</Txt>
            </Press>
          </View>
        )}

        {found?.kind === 'addon' && <AddonFound found={found} busy={busy} onInstall={install} onConfigure={() => continueWith(found.link)} />}

        {found?.kind === 'paperback' && (
          <View style={{ gap: S.md }}>
            <PreviewCard
              kind="Manhwa · dépôt Paperback"
              icon="book-outline"
              name={found.repo.name}
              meta={`Paperback ${found.repo.format} · ${hostOf(found.repo.url)}`}
              description={found.repo.description}
              caps={[{ label: `${found.repo.sources.length} source${found.repo.sources.length > 1 ? 's' : ''}`, icon: 'library-outline', tone: 'accent' }]}
              lines={[
                { icon: 'server-outline', text: `Hébergé par ${hostOf(found.repo.url)}, pas par Huwa` },
                { icon: 'lock-closed-outline', text: 'Les sources s’exécutent isolées, sans accès à tes données Huwa' },
              ]}
            />
            <Button label="Ajouter le dépôt" icon="add" onPress={() => continueWith(found.link)} />
            <Txt v="small" style={{ textAlign: 'center' }}>Tu choisiras ensuite les sources à installer.</Txt>
          </View>
        )}

        {found?.kind === 'pack' && (
          <View style={{ gap: S.md }}>
            <PreviewCard
              kind="Pack d’extensions"
              icon="albums-outline"
              name={found.pack.name}
              meta={[found.pack.author && `par ${found.pack.author}`, packHost(found.link) ?? 'contenu dans le lien'].filter(Boolean).join(' · ')}
              description={found.pack.description}
              caps={[
                ...(found.pack.video.length ? [{ label: `${found.pack.video.length} vidéo`, icon: 'play-circle-outline' as const, tone: 'accent' as const }] : []),
                ...(found.pack.manga.length ? [{ label: `${found.pack.manga.length} manhwa`, icon: 'book-outline' as const, tone: 'accent' as const }] : []),
              ]}
            />
            <Button label={`Voir le pack (${found.pack.video.length + found.pack.manga.length})`} icon="arrow-forward" iconRight onPress={() => continueWith(found.link)} />
            <Txt v="small" style={{ textAlign: 'center' }}>Tu choisiras une à une les extensions à installer.</Txt>
          </View>
        )}

        {!text.trim() && (
          <>
            <TrustNote />

            <Card>
              <LinkRow icon="qr-code-outline" label="Scanner un QR code" hint="Le QR d’un pack, d’un addon ou d’un dépôt." onPress={() => setScanning(true)} />
              <LinkRow icon="compass-outline" label="Découvrir le catalogue Stremio" hint="L’annuaire des addons publics, fourni par tes addons." onPress={openDirectory} />
              <LinkRow icon="globe-outline" label="Ouvrir le site des extensions" hint="huwa.mciut.fr : bouton « Ajouter à Huwa » et QR pour n’importe quel addon." external last onPress={() => WebBrowser.openBrowserAsync(EXTENSIONS_SITE)} />
            </Card>

            {!manga && (
              <View style={{ gap: S.sm }}>
                <Txt v="caption" accessibilityRole="header" style={{ paddingHorizontal: S.md }}>Recommandées</Txt>
                <RecommendedExtensions />
                <Txt v="small" style={{ paddingHorizontal: S.xs, lineHeight: 18 }}>Sous-titres, catalogues et fiches : elles ne fournissent aucune vidéo.</Txt>
              </View>
            )}
          </>
        )}
      </ScrollView>

      <Scanner
        visible={scanning}
        onClose={() => setScanning(false)}
        onLink={(raw) => {
          setScanning(false);
          setText(raw);
        }}
      />
    </View>
  );
}

function AddonFound({ found, busy, onInstall, onConfigure }: { found: Extract<Found, { kind: 'addon' }>; busy: boolean; onInstall: () => void; onConfigure: () => void }) {
  const m = found.manifest;
  const mustConfigure = needsConfiguration(m);
  const lines: PreviewLine[] = [{ icon: 'server-outline', text: `Hébergée par ${hostOf(found.baseUrl)}, pas par Huwa` }];
  if (mustConfigure) lines.push({ icon: 'settings-outline', text: 'À configurer sur son site avant de servir quoi que ce soit', tone: 'warn' });
  if (found.existing) lines.push({ icon: 'refresh-outline', text: 'Déjà installée : cette version remplacera l’actuelle' });
  return (
    <View style={{ gap: S.md }}>
      <PreviewCard
        kind="Vidéo · addon Stremio"
        logo={logoOf(m)}
        name={m.name}
        meta={[m.version && `v${m.version}`, hostOf(found.baseUrl)].filter(Boolean).join(' · ')}
        description={m.description}
        caps={capabilities(m)}
        lines={lines}
      />
      {mustConfigure ? (
        <Button label="Configurer sur son site" icon="settings-outline" onPress={onConfigure} />
      ) : (
        <>
          <Button label={busy ? 'Installation…' : found.existing ? 'Mettre à jour' : 'Installer'} icon="add" onPress={onInstall} />
          {m.behaviorHints?.configurable && <Button small variant="soft" icon="settings-outline" label="Configurer d’abord" onPress={onConfigure} />}
        </>
      )}
      <Txt v="small" style={{ textAlign: 'center', lineHeight: 18 }}>En installant, tu confirmes choisir cette extension et en être responsable.</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.surface },
  center: { alignItems: 'center', justifyContent: 'center', gap: S.md, padding: S.xl },
  wrap: { padding: S.lg, gap: S.lg },
  field: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: 54, paddingHorizontal: S.md,
    borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.elevated, borderWidth: 1, borderColor: C.borderStrong,
    boxShadow: 'inset 0px 1px 2px rgba(0,0,0,0.35)',
  },
  input: { flex: 1, minHeight: 52, color: C.text, ...F.medium, fontSize: 16 },
  status: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm, padding: S.md, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border,
  },
  doneIcon: {
    width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: C.elevated,
    borderWidth: 1, borderColor: 'rgba(61,220,151,0.35)', boxShadow: '0px 0px 0px 10px rgba(61,220,151,0.10)', marginBottom: S.sm,
  },
});
