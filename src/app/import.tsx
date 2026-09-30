// "Importer ma bibliothèque": brings a user's own list from Stremio or anime-sama, from the
// export file each service lets him download. Titles are matched to AniList and reviewed
// before anything is written. Stremio addons found in the export can be reinstalled one by one.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { normalizeAddonUrl } from '@/addons/protocol';
import { useAddons } from '@/addons/registry';
import { Group, Row } from '@/components/states';
import { Button, Cover, IconButton, Txt } from '@/components/ui';
import type { ListStatus } from '@/data/anilist-api';
import { isAnimeSamaExport, parseAnimeSamaExport } from '@/import/anime-sama';
import { parseJsonText, pickJsonFile } from '@/import/pick';
import { resolveCandidates, toEntries, type Candidate, type Match } from '@/import/resolve';
import { parseStremioExport } from '@/import/stremio';
import { applyImportedEntries } from '@/settings/anilist-sync';
import { C, F, R, S } from '@/theme/tokens';

type Source = 'Stremio' | 'anime-sama';
type Phase =
  | { k: 'idle' }
  | { k: 'resolving'; source: Source; done: number; total: number }
  | { k: 'review'; source: Source; matches: Match[]; missed: string[]; addons: string[] }
  | { k: 'done'; source: Source; n: number; addons: string[] };

const STATUS_LABEL: Record<ListStatus, string> = {
  CURRENT: 'En cours',
  REPEATING: 'En cours',
  PLANNING: 'À voir',
  PAUSED: 'En pause',
  COMPLETED: 'Terminé',
  DROPPED: 'Abandonné',
};

export default function ImportLibrary() {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [off, setOff] = useState<Set<string>>(new Set());
  const [paste, setPaste] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);

  const run = async (json: unknown) => {
    let source: Source;
    let cands: Candidate[];
    let addons: string[] = [];
    if (isAnimeSamaExport(json)) {
      source = 'anime-sama';
      cands = parseAnimeSamaExport(json).map((x) => ({ source: x.title, status: x.status, manhwa: x.manhwa }));
    } else {
      source = 'Stremio';
      const exp = parseStremioExport(json);
      addons = exp.addons;
      cands = exp.items.map((x) => ({ source: x.name, status: x.status, stremioId: x.id.split(':').slice(0, 2).join(':') }));
    }
    if (!cands.length && !addons.length) {
      Alert.alert('Rien à importer', 'Ce fichier ne contient ni liste ni addon reconnus. Vérifie que c’est bien l’export de Stremio ou d’anime-sama.');
      return;
    }
    setPhase({ k: 'resolving', source, done: 0, total: cands.length });
    try {
      const res = await resolveCandidates(cands, (done, total) => setPhase({ k: 'resolving', source, done, total }));
      setOff(new Set());
      setPhase({ k: 'review', source, matches: res.matches, missed: res.missed, addons });
    } catch (e) {
      setPhase({ k: 'idle' });
      Alert.alert('Import impossible', e instanceof Error ? e.message : String(e));
    }
  };

  const fromFile = async () => {
    try {
      const json = await pickJsonFile();
      if (json != null) await run(json);
    } catch (e) {
      Alert.alert('Import impossible', e instanceof Error ? e.message : String(e));
    }
  };

  const fromPaste = async () => {
    try {
      await run(parseJsonText(paste));
    } catch (e) {
      Alert.alert('Import impossible', e instanceof Error ? e.message : String(e));
    }
  };

  const confirm = () => {
    if (phase.k !== 'review') return;
    const chosen = phase.matches.filter((m) => !off.has(m.series.id));
    const n = applyImportedEntries(toEntries(chosen), phase.source);
    setPhase({ k: 'done', source: phase.source, n, addons: phase.addons });
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: insets.top + S.sm, paddingHorizontal: S.lg, gap: S.xl, paddingBottom: S.xxl + insets.bottom }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
        <Txt v="display" style={{ fontSize: 26, flex: 1 }} numberOfLines={1}>Importer</Txt>
      </View>

      {phase.k === 'idle' && (
        <>
          <Txt v="small">
            Reprends ta liste depuis une autre app, à partir du fichier d’export qu’elle te donne. Le fichier reste sur ton téléphone : Huwa n’envoie que les titres à AniList pour les reconnaître.
          </Txt>

          <View style={styles.card}>
            <Txt v="section">Stremio</Txt>
            <Step n={1} text="Sur web.stremio.com, connecte-toi puis ouvre Paramètres." />
            <Step n={2} text="Touche « Exporter les données utilisateur » : tu obtiens un fichier export.json (ta bibliothèque et tes addons)." />
            <Step n={3} text="Choisis ce fichier ici. Seuls les anime reconnus sont importés ; tu pourras réinstaller tes addons." />
            <Button label="Choisir export.json" icon="document-outline" onPress={fromFile} />
            <Button small variant="soft" icon="open-outline" label="Ouvrir web.stremio.com" onPress={() => WebBrowser.openBrowserAsync('https://web.stremio.com/#/settings')} />
          </View>

          <View style={styles.card}>
            <Txt v="section">anime-sama</Txt>
            <Step n={1} text="Sur anime-sama, connecte-toi et ouvre ton Profil." />
            <Step n={2} text="Touche « Exporter » : tu obtiens un fichier anime-sama_sauvegarde_….json (historique, watchlist, favoris, vus)." />
            <Step n={3} text="Choisis ce fichier ici. Les titres sont retrouvés sur AniList ; tu vérifies avant d’importer." />
            <Button label="Choisir la sauvegarde" icon="document-outline" onPress={fromFile} />
          </View>

          <Group title="AUTRES">
            <Row icon="swap-horizontal-outline" label="AniList" hint="Import par nom d’utilisateur, dans Réglages → Général." last onPress={() => router.push('/settings/general' as Href)} />
          </Group>

          <View style={{ gap: S.sm }}>
            <Button small variant="ghost" icon="clipboard-outline" label={pasteOpen ? 'Masquer' : 'Coller le contenu du fichier à la place'} onPress={() => setPasteOpen((x) => !x)} />
            {pasteOpen && (
              <>
                <TextInput
                  value={paste}
                  onChangeText={setPaste}
                  placeholder='{"_app":"anime-sama", … } ou {"library": … }'
                  placeholderTextColor={C.text2}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.paste}
                />
                <Button small label="Analyser" onPress={fromPaste} />
              </>
            )}
          </View>
        </>
      )}

      {phase.k === 'resolving' && (
        <View style={{ alignItems: 'center', gap: S.md, paddingVertical: S.xxl }}>
          <ActivityIndicator color={C.accentText} />
          <Txt v="label">Recherche des titres sur AniList…</Txt>
          <Txt v="small">{phase.done} / {phase.total}</Txt>
        </View>
      )}

      {phase.k === 'review' && (
        <View style={{ gap: S.md }}>
          <Txt v="label">
            {phase.matches.length} titre{phase.matches.length > 1 ? 's' : ''} reconnu{phase.matches.length > 1 ? 's' : ''} depuis {phase.source}
          </Txt>
          <Txt v="small">Décoche ce qui a été mal reconnu. Les statuts sont copiés et tout va dans la liste « {phase.source} » ; ce qui est en cours rejoint Ma liste.</Txt>
          {phase.matches.map((m) => {
            const on = !off.has(m.series.id);
            return (
              <View key={m.series.id} style={styles.match}>
                <Cover palette={m.series.palette} image={m.series.image} width={40} height={56} radius={8} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt v="label" numberOfLines={1}>{m.series.title}</Txt>
                  <Txt v="small" numberOfLines={1}>{STATUS_LABEL[m.status]} · « {m.source} »</Txt>
                </View>
                <Switch
                  value={on}
                  onValueChange={() => setOff((s) => {
                    const n = new Set(s);
                    if (on) n.add(m.series.id);
                    else n.delete(m.series.id);
                    return n;
                  })}
                  trackColor={{ true: C.accent }}
                  accessibilityLabel={`Importer ${m.series.title}`}
                />
              </View>
            );
          })}
          {phase.missed.length > 0 && (
            <Txt v="small">Non reconnus ({phase.missed.length}) : {phase.missed.slice(0, 30).join(', ')}{phase.missed.length > 30 ? '…' : ''}</Txt>
          )}
          <Button label={`Importer ${phase.matches.length - off.size} titre${phase.matches.length - off.size > 1 ? 's' : ''}`} icon="download-outline" onPress={confirm} />
          <Button small variant="ghost" label="Annuler" onPress={() => setPhase({ k: 'idle' })} />
          {phase.addons.length > 0 && <AddonsFound urls={phase.addons} />}
        </View>
      )}

      {phase.k === 'done' && (
        <View style={{ gap: S.md }}>
          <View style={{ alignItems: 'center', gap: S.sm, paddingVertical: S.lg }}>
            <Ionicons name="checkmark-circle" size={48} color={C.success} />
            <Txt v="title">{phase.n} titre{phase.n > 1 ? 's' : ''} importé{phase.n > 1 ? 's' : ''}</Txt>
            <Txt v="small">Dans Listes → « {phase.source} ».</Txt>
          </View>
          <Button label="Voir mes listes" onPress={() => router.replace('/lists' as Href)} />
          {phase.addons.length > 0 && <AddonsFound urls={phase.addons} />}
        </View>
      )}
    </ScrollView>
  );
}

function AddonsFound({ urls }: { urls: string[] }) {
  const installed = new Set(useAddons().map((a) => a.baseUrl));
  return (
    <View style={[styles.card, { marginTop: S.md }]}>
      <Txt v="section">Tes addons Stremio ({urls.length})</Txt>
      <Txt v="small">Trouvés dans ton export. Chaque ajout passe par l’écran de confirmation.</Txt>
      {urls.map((u) => {
        const base = normalizeAddonUrl(u);
        const has = installed.has(base);
        return (
          <View key={u} style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
            <Txt v="small" numberOfLines={1} style={{ flex: 1 }}>{base.replace(/^https?:\/\//, '')}</Txt>
            <Button small variant={has ? 'ghost' : 'soft'} label={has ? 'Installé' : 'Ajouter'}
              onPress={() => router.push({ pathname: '/addon', params: { url: u } } as unknown as Href)} />
          </View>
        );
      })}
    </View>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: S.sm }}>
      <Txt v="label" color={C.accentText} style={{ width: 18 }}>{n}.</Txt>
      <Txt v="small" style={{ flex: 1, color: C.body }}>{text}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: S.md, padding: S.lg, borderRadius: R.card, backgroundColor: C.surface },
  match: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.sm, borderRadius: R.card, backgroundColor: C.surface },
  paste: {
    minHeight: 120, maxHeight: 240, padding: S.md, borderRadius: R.card, backgroundColor: C.surface,
    color: C.text, ...F.medium, fontSize: 13, textAlignVertical: 'top',
  },
});
