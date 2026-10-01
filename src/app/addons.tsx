// "Extensions": every source the user adds himself. Huwa ships none.
//  - Vidéo: Stremio-compatible addons (streams, catalogs, subtitles, addon catalogs).
//  - Manhwa: Paperback repositories and sources, managed in detail by `/manga-sources`.
// Adding anything goes through one screen, `/extension-add`, which recognizes the pasted link.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hasResource } from '@/addons/protocol';
import { QUALITIES, type Quality } from '@/addons/quality';
import { EXTENSIONS_SITE } from '@/addons/recommended';
import { BUILTIN_ID, moveAddon, setPrefs, toggleAddon, useAddonPrefs, useAddons, type InstalledAddon } from '@/addons/registry';
import { capabilities, CapChips, Card, EmptyCard, ExtLogo, LinkRow, logoOf, SectionTitle, TrustNote } from '@/components/extension-ui';
import { SourceIcon } from '@/components/paperback';
import { Button, IconButton, Press, Txt } from '@/components/ui';
import { useDebrid } from '@/debrid/store';
import { extensionsSupported, toggleSource, useMangaExt } from '@/manga-ext/registry';
import { C, F, R, S } from '@/theme/tokens';

const MAX_SOURCES = 5;

const openAdd = (kind?: 'video' | 'manga') => router.push({ pathname: '/extension-add', params: kind ? { kind } : {} } as unknown as Href);

export default function Extensions() {
  const insets = useSafeAreaInsets();
  const addons = useAddons();
  const prefs = useAddonPrefs();
  const { provider } = useDebrid();
  const { repos, installed } = useMangaExt();
  const [reorder, setReorder] = useState(false);
  const mine = addons.filter((a) => a.manifest.id !== BUILTIN_ID);
  const directories = addons
    .filter((a) => a.enabled && hasResource(a.manifest, 'addon_catalog'))
    .flatMap((a) => (a.manifest.addonCatalogs ?? []).map((c) => ({ a, c })));

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      contentContainerStyle={{ paddingTop: insets.top + S.sm, paddingHorizontal: S.lg, gap: S.xl, paddingBottom: S.xxl + insets.bottom }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
        <Txt v="display" style={{ fontSize: 28, flexShrink: 1 }} numberOfLines={1} accessibilityRole="header">Extensions</Txt>
      </View>

      <View style={{ gap: S.md }}>
        <Txt v="body" style={{ color: C.body }}>
          Les extensions apportent à Huwa les vidéos, sous-titres et chapitres. Tu choisis celles que tu ajoutes.
        </Txt>
        <Button label="Ajouter une extension" icon="add" onPress={() => openAdd()} />
        <TrustNote />
      </View>

      {/* ---------- Vidéo ---------- */}
      <View style={{ gap: S.md }}>
        <SectionTitle icon="play-circle-outline" title="Vidéo" subtitle="Addons Stremio : flux, sous-titres, catalogues" count={mine.length} action={mine.length ? 'Ajouter' : undefined} onAction={() => openAdd('video')} />

        {!mine.length && (
          <EmptyCard icon="film-outline" text="Aucun addon vidéo pour l’instant. Ajoute un addon compatible Stremio pour trouver des sources." action="Ajouter un addon" onAction={() => openAdd('video')} />
        )}

        <Card>
          {addons.map((a, i) => (
            <AddonRow key={a.baseUrl} a={a} index={i} count={addons.length} reorder={reorder} last={i === addons.length - 1} />
          ))}
        </Card>
        {addons.length > 1 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.xs }}>
            <Txt v="small" style={{ flex: 1, lineHeight: 18 }}>L’ordre fixe la priorité : à qualité égale, les sources du premier passent devant.</Txt>
            <Press onPress={() => setReorder(!reorder)} hitSlop={8} accessibilityRole="button" accessibilityState={{ selected: reorder }} style={[styles.reorder, reorder && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
              <Ionicons name={reorder ? 'checkmark' : 'swap-vertical'} size={14} color={C.accentText} />
              <Txt v="small" color={C.accentText} style={F.semibold}>{reorder ? 'OK' : 'Réordonner'}</Txt>
            </Press>
          </View>
        )}

        <Card tinted={!!provider}>
          <LinkRow
            icon="flash-outline"
            label="Accélérer avec un service débrid"
            hint={provider ? `${provider.name} actif : les sources torrent sont lisibles.` : 'Optionnel : rend lisibles les sources torrent (TorBox, Real-Debrid…).'}
            last={!directories.length}
            onPress={() => router.push('/debrid' as Href)}
          />
          {directories.map(({ a, c }, i) => (
            <LinkRow
              key={`${a.baseUrl}|${c.type}|${c.id}`}
              icon="compass-outline"
              label={`Annuaire : ${c.name ?? c.id}`}
              hint={`Addons publics, liste fournie par ${a.manifest.name}`}
              last={i === directories.length - 1}
              onPress={() => router.push({ pathname: '/addon-catalog', params: { addon: a.baseUrl, type: c.type, id: c.id, name: c.name ?? c.id } } as unknown as Href)}
            />
          ))}
        </Card>

        <View style={{ gap: S.sm }}>
          <Txt v="caption" style={{ paddingHorizontal: S.xs }}>Qualité préférée</Txt>
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
          <Txt v="small" style={{ paddingHorizontal: S.xs, lineHeight: 18 }}>Si une source échoue, Huwa passe automatiquement à la suivante.</Txt>
        </View>
      </View>

      {/* ---------- Manhwa ---------- */}
      <View style={{ gap: S.md }}>
        <SectionTitle
          icon="book-outline"
          title="Manhwa"
          subtitle="Dépôts Paperback : chapitres à lire"
          count={installed.length}
          action={extensionsSupported && (installed.length || repos.length) ? 'Ajouter' : undefined}
          onAction={() => openAdd('manga')}
        />
        {!extensionsSupported ? (
          <Txt v="small">Les extensions Paperback ne sont disponibles que dans l’app iOS / Android.</Txt>
        ) : !installed.length && !repos.length ? (
          <EmptyCard icon="library-outline" text="Aucune source manhwa. Ajoute un dépôt Paperback, puis choisis les sources à installer." action="Ajouter un dépôt" onAction={() => openAdd('manga')} />
        ) : (
          <Card>
            {installed.slice(0, MAX_SOURCES).map((s) => (
              <View key={s.key} style={[styles.row, styles.line]}>
                <SourceIcon source={s} size={40} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt v="label" numberOfLines={1}>{s.name}</Txt>
                  <Txt v="small" numberOfLines={1} style={{ fontSize: 12 }}>
                    {[s.language?.toUpperCase(), `v${s.version}`, `Paperback ${s.format}`].filter(Boolean).join(' · ')}
                  </Txt>
                </View>
                <Switch value={s.enabled} onValueChange={() => toggleSource(s.key)} trackColor={{ true: C.accent }} accessibilityLabel={`Activer ${s.name}`} />
              </View>
            ))}
            <LinkRow
              icon="layers-outline"
              label={installed.length ? 'Gérer les dépôts et sources' : 'Choisir des sources'}
              hint={[
                `${repos.length} dépôt${repos.length > 1 ? 's' : ''}`,
                installed.length > MAX_SOURCES && `${installed.length - MAX_SOURCES} autre${installed.length - MAX_SOURCES > 1 ? 's' : ''} source${installed.length - MAX_SOURCES > 1 ? 's' : ''}`,
              ].filter(Boolean).join(' · ')}
              last
              onPress={() => router.push('/manga-sources')}
            />
          </Card>
        )}
      </View>

      {/* ---------- More ---------- */}
      <View style={{ gap: S.sm }}>
        <Txt v="caption" style={{ paddingHorizontal: S.xs }}>Plus</Txt>
        <Card>
          <LinkRow icon="share-social-outline" label="Partager mes extensions" hint="Un pack (lien + QR) pour qu’un ami installe les mêmes en un geste." onPress={() => router.push('/pack-create' as Href)} />
          <LinkRow icon="download-outline" label="Importer depuis Stremio ou anime-sama" hint="Reprends ta liste et tes addons sans repartir de zéro." onPress={() => router.push('/import' as Href)} />
          <LinkRow icon="globe-outline" label="Site des extensions" hint="huwa.mciut.fr : bouton « Ajouter à Huwa » et QR pour n’importe quel addon." external last onPress={() => WebBrowser.openBrowserAsync(EXTENSIONS_SITE)} />
        </Card>
      </View>
    </ScrollView>
  );
}

function AddonRow({ a, index, count, reorder, last }: { a: InstalledAddon; index: number; count: number; reorder: boolean; last: boolean }) {
  const m = a.manifest;
  const builtin = m.id === BUILTIN_ID;
  const caps = capabilities(m, false);
  return (
    <Press
      onPress={() => router.push({ pathname: '/extension', params: { url: a.baseUrl } } as unknown as Href)}
      scaleTo={0.99}
      accessibilityRole="button"
      accessibilityLabel={`${m.name}, priorité ${index + 1}, ${a.enabled ? 'activée' : 'désactivée'}`}
      accessibilityHint="Ouvre le détail de l’extension"
      style={[styles.row, !last && styles.line]}>
      <View style={!a.enabled && { opacity: 0.45 }}>
        <ExtLogo uri={logoOf(m)} name={m.name} size={44} icon={builtin ? 'play-circle-outline' : undefined} />
      </View>
      <View style={{ flex: 1, gap: 4, opacity: a.enabled ? 1 : 0.6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {reorder && <Txt v="small" color={C.accentText} style={{ fontSize: 12, ...F.bold }}>{index + 1}.</Txt>}
          <Txt v="label" numberOfLines={1} style={{ flexShrink: 1 }}>{m.name}</Txt>
        </View>
        {!!m.description && <Txt v="small" numberOfLines={1} style={{ fontSize: 12 }}>{m.description}</Txt>}
        <CapChips caps={caps} max={2} />
      </View>
      {reorder ? (
        <View style={{ gap: 6 }}>
          <IconButton icon="chevron-up" label={`Monter ${m.name}`} size={30} tone="solid" color={index === 0 ? C.text2 : C.text} onPress={() => moveAddon(a.baseUrl, -1)} />
          <IconButton icon="chevron-down" label={`Descendre ${m.name}`} size={30} tone="solid" color={index === count - 1 ? C.text2 : C.text} onPress={() => moveAddon(a.baseUrl, 1)} />
        </View>
      ) : (
        <Switch value={a.enabled} onValueChange={() => toggleAddon(a.baseUrl)} trackColor={{ true: C.accent }} accessibilityLabel={`Activer ${m.name}`} />
      )}
    </Press>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md },
  line: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.borderStrong },
  reorder: {
    flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32, paddingHorizontal: 10, borderRadius: R.pill,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.surface,
  },
  qual: {
    minHeight: 40, minWidth: 64, paddingHorizontal: S.md, alignItems: 'center', justifyContent: 'center',
    borderRadius: R.control, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface,
  },
});
