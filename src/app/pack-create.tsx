// "Partager mes extensions": builds a pack from the user's installed extensions and shares it as
// a link (https://huwa.mciut.fr/pack.html#<payload>, the pack travels inside the link).
// URLs that look personal (debrid key, token, encrypted config) start unchecked, with a warning.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BUILTIN_ID, useAddons } from '@/addons/registry';
import { CheckGroup, CheckRow, Notice } from '@/components/pack-rows';
import { Field } from '@/components/social';
import { Button, IconButton, Press, Txt } from '@/components/ui';
import { useMangaExt } from '@/manga-ext/registry';
import { encodePack, packAppLink, packJson, packWebLink, validatePack, type Pack } from '@/packs/format';
import { hostOf } from '@/packs/install';
import { looksPersonal, PERSONAL_WARNING } from '@/packs/secrets';
import { C, F, R, S } from '@/theme/tokens';

/** Above this, the QR code gets too dense for a phone camera: share the link instead. */
const QR_MAX = 1200;

type Item = { id: string; title: string; subtitle: string; personal: boolean; video?: Pack['video'][number]; manga?: Pack['manga'][number] };

export default function PackCreate() {
  const insets = useSafeAreaInsets();
  const addons = useAddons();
  const { repos, installed } = useMangaExt();
  const [name, setName] = useState('Mes extensions');
  const [description, setDescription] = useState('');
  // Explicit choices only; the default depends on `personal`.
  const [choice, setChoice] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<{ pack: Pack; web: string; app: string } | null>(null);

  const items = useMemo<Item[]>(() => {
    const video: Item[] = addons
      .filter((a) => a.manifest.id !== BUILTIN_ID && /^https?:\/\//i.test(a.baseUrl))
      .map((a) => {
        const manifest = `${a.baseUrl}/manifest.json`;
        return { id: `v|${a.baseUrl}`, title: a.manifest.name, subtitle: hostOf(a.baseUrl), personal: looksPersonal(manifest), video: { manifest, name: a.manifest.name } };
      });
    const manga: Item[] = repos.map((r) => {
      const mine = installed.filter((s) => s.repo === r.url);
      const subtitle = `${hostOf(r.url)} · ${mine.length ? `${mine.length} source${mine.length > 1 ? 's' : ''} : ${mine.map((s) => s.name).join(', ')}` : 'aucune source installée'}`;
      return {
        id: `m|${r.url}`,
        title: r.name,
        subtitle,
        personal: looksPersonal(r.url),
        manga: { repo: r.url, name: r.name, ...(mine.length ? { sources: mine.map((s) => s.id).slice(0, 50) } : {}) },
      };
    });
    return [...video, ...manga];
  }, [addons, repos, installed]);

  const isOn = (it: Item) => choice[it.id] ?? !it.personal;
  const chosen = items.filter(isOn);
  const videoItems = items.filter((i) => i.video);
  const mangaItems = items.filter((i) => i.manga);
  const personalChosen = chosen.filter((i) => i.personal).length;

  const build = () => {
    try {
      const pack = validatePack({
        huwaPack: 1,
        name: name.trim() || 'Mes extensions',
        description: description.trim() || undefined,
        video: chosen.flatMap((i) => (i.video ? [i.video] : [])),
        manga: chosen.flatMap((i) => (i.manga ? [i.manga] : [])),
      });
      const d = encodePack(pack);
      setResult({ pack, web: packWebLink({ d }), app: packAppLink({ d }) });
    } catch (e) {
      Alert.alert('Pack impossible', e instanceof Error ? e.message : String(e));
    }
  };

  const share = () => {
    if (!result) return;
    const count = result.pack.video.length + result.pack.manga.length;
    Share.share({ message: `« ${result.pack.name} » : ${count} extension${count > 1 ? 's' : ''} pour Huwa\n${result.web}` }).catch(() => {});
  };
  const shareApp = () => result && Share.share({ message: result.app }).catch(() => {});
  const shareJson = () => result && Share.share({ message: JSON.stringify(JSON.parse(packJson(result.pack)), null, 2) }).catch(() => {});

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: insets.top + S.sm, paddingHorizontal: S.lg, gap: S.xl, paddingBottom: S.xxl + insets.bottom }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => (result ? setResult(null) : router.back())} />
        <Txt v="display" style={{ fontSize: 26, flexShrink: 1 }} numberOfLines={1}>{result ? 'Ton pack' : 'Partager'}</Txt>
      </View>

      {result ? (
        <>
          <View style={{ gap: S.xs }}>
            <Txt v="title">{result.pack.name}</Txt>
            <Txt v="small">
              {[result.pack.video.length && `${result.pack.video.length} vidéo`, result.pack.manga.length && `${result.pack.manga.length} manhwa`].filter(Boolean).join(' · ')}
            </Txt>
          </View>

          {result.web.length <= QR_MAX ? (
            <View style={{ alignItems: 'center', gap: S.sm }}>
              <View style={styles.qr} accessible accessibilityRole="image" accessibilityLabel="QR code du pack">
                <QRCode value={result.web} size={232} color="#05070D" backgroundColor="#FFFFFF" ecl="L" quietZone={12} />
              </View>
              <Txt v="small" style={{ textAlign: 'center' }}>À scanner avec l’appareil photo ou depuis l’introduction de Huwa.</Txt>
            </View>
          ) : (
            <Notice text="Ce pack est trop long pour un QR code lisible : partage plutôt le lien." />
          )}

          <Button label="Partager le lien" icon="share-outline" onPress={share} />
          <View style={styles.link}>
            <Txt v="small" selectable numberOfLines={4} style={{ fontSize: 12, color: C.body }}>{result.web}</Txt>
          </View>
          <Txt v="small">
            Le pack est dans le lien lui-même : rien n’est envoyé à Huwa ni stocké sur un serveur. La page s’ouvre aussi sans l’app et propose « Ouvrir dans Huwa ».
          </Txt>
          <View style={{ flexDirection: 'row', gap: S.sm }}>
            <Button style={{ flex: 1 }} small variant="ghost" icon="link-outline" label="Lien huwa://" onPress={shareApp} />
            <Button style={{ flex: 1 }} small variant="ghost" icon="code-outline" label="Fichier JSON" onPress={shareJson} />
          </View>
          <Txt v="small" style={{ fontSize: 12 }}>
            Le fichier JSON peut être hébergé où tu veux : le lien huwa://pack?url=&lt;adresse du fichier&gt; l’ouvre alors dans Huwa.
          </Txt>
          {personalChosen > 0 && <Notice text={`${personalChosen} lien${personalChosen > 1 ? 's' : ''} de ce pack contien${personalChosen > 1 ? 'nent' : 't'} peut-être ta configuration ou une clé personnelle. Ne le partage qu’avec des personnes de confiance.`} />}
        </>
      ) : (
        <>
          <Txt v="small">
            Choisis les extensions à mettre dans ton pack. Il ne contient que leurs liens : la personne qui le reçoit les installe depuis leurs auteurs, après confirmation.
          </Txt>

          <View style={{ gap: S.md }}>
            <Field label="Nom du pack" value={name} onChangeText={setName} maxLength={80} placeholder="Mes extensions" />
            <Field label="Description (facultatif)" value={description} onChangeText={setDescription} maxLength={500} multiline placeholder="Ce que contient ce pack" />
          </View>

          {!items.length && (
            <View style={styles.empty}>
              <Ionicons name="extension-puzzle-outline" size={26} color={C.accentText} />
              <Txt v="small" style={{ textAlign: 'center' }}>Aucune extension installée à partager pour l’instant.</Txt>
            </View>
          )}

          {videoItems.length > 0 && (
            <CheckGroup title="VIDÉO · ADDONS STREMIO">
              {videoItems.map((it, i) => (
                <CheckRow
                  key={it.id}
                  checked={isOn(it)}
                  onToggle={() => setChoice((c) => ({ ...c, [it.id]: !isOn(it) }))}
                  title={it.title}
                  subtitle={it.subtitle}
                  warning={it.personal ? PERSONAL_WARNING : undefined}
                  last={i === videoItems.length - 1}
                />
              ))}
            </CheckGroup>
          )}

          {mangaItems.length > 0 && (
            <CheckGroup title="MANHWA · DÉPÔTS PAPERBACK">
              {mangaItems.map((it, i) => (
                <CheckRow
                  key={it.id}
                  checked={isOn(it)}
                  onToggle={() => setChoice((c) => ({ ...c, [it.id]: !isOn(it) }))}
                  title={it.title}
                  subtitle={it.subtitle}
                  warning={it.personal ? PERSONAL_WARNING : undefined}
                  last={i === mangaItems.length - 1}
                />
              ))}
            </CheckGroup>
          )}

          {items.length > 0 && (
            <>
              <Press
                onPress={build}
                disabled={!chosen.length}
                accessibilityRole="button"
                accessibilityState={{ disabled: !chosen.length }}
                style={[styles.cta, !chosen.length && { opacity: 0.45 }]}>
                <Ionicons name="share-outline" size={16} color={C.onAccent} />
                <Txt v="caption" color={C.onAccent} style={{ fontSize: 13, letterSpacing: 0.8, ...F.heavy }}>
                  {`Partager (${chosen.length})`}
                </Txt>
              </Press>
              <Txt v="small" style={{ fontSize: 12 }}>
                Huwa ne publie ni ne vérifie les packs. Partage seulement des extensions dont les contenus peuvent légalement être utilisés.
              </Txt>
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  qr: { padding: 4, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: '#FFFFFF', overflow: 'hidden' },
  link: { padding: S.md, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  empty: { alignItems: 'center', gap: S.sm, padding: S.xl, borderRadius: R.card, backgroundColor: C.surface },
  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm, minHeight: 50, paddingHorizontal: 18,
    borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
});
