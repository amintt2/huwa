// "Extensions manhwa": Paperback extension repositories and sources. Huwa ships none; the user
// adds a repository (URL, `paperback://addRepo…` link or `huwa://paperback?repo=…`) and installs sources.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SourceIcon } from '@/components/paperback';
import { Button, IconButton, Press, Txt } from '@/components/ui';
import {
  addRepo,
  extensionsSupported,
  installSource,
  refreshRepo,
  removeRepo,
  setLegalAccepted,
  setShowAdult,
  toggleSource,
  uninstallSource,
  updateFor,
  useMangaExt,
  type RepoEntry,
} from '@/manga-ext/registry';
import type { RepoSource } from '@/manga-ext/repo';
import { classifyLink } from '@/packs/format';
import { hrefFor } from '@/packs/routes';
import { C, F, R, S } from '@/theme/tokens';

const LEGAL =
  'Huwa ne fournit, n’héberge ni n’indexe aucun contenu et n’inclut aucune extension. Une extension Paperback est un programme tiers qui lit un site : ' +
  'tu es seul responsable des dépôts et des sources que tu ajoutes, et de leur légalité dans ton pays. Elles s’exécutent isolées, sans accès à tes données Huwa.';

const confirmLegal = () =>
  new Promise<boolean>((resolve) =>
    Alert.alert('Avant d’installer une source', LEGAL, [
      { text: 'Annuler', style: 'cancel', onPress: () => resolve(false) },
      { text: 'J’ai compris', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }),
  );

const RATING: Record<RepoSource['contentRating'], string> = { EVERYONE: 'Tout public', MATURE: 'Mature', ADULT: 'Adulte' };

export default function MangaSources() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ repo?: string }>();
  const { repos, installed, legalAccepted, showAdult } = useMangaExt();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const handled = useRef<string | undefined>(undefined);

  const ensureLegal = async () => {
    if (legalAccepted) return true;
    if (!(await confirmLegal())) return false;
    setLegalAccepted();
    return true;
  };

  const install = async (repo: string, id: string) => {
    if (!(await ensureLegal())) return;
    setBusy(`${repo}|${id}`);
    try {
      await installSource(repo, id);
    } catch (e) {
      Alert.alert('Installation impossible', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const add = async (input = url) => {
    if (!input.trim() || busy) return;
    const link = classifyLink(input);
    if (link?.kind === 'pack') {
      // A pack pasted here: open its confirmation screen.
      setUrl('');
      router.push(hrefFor(link));
      return;
    }
    setBusy('add');
    setError('');
    try {
      const { repo, install: ids } = await addRepo(input);
      setUrl('');
      setOpen(repo.url);
      if (ids.length) {
        Alert.alert(`Installer ${ids.length} source${ids.length > 1 ? 's' : ''} ?`, ids.join(', '), [
          { text: 'Plus tard', style: 'cancel' },
          {
            text: 'Installer',
            onPress: async () => {
              for (const id of ids) await install(repo.url, id);
            },
          },
        ]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dépôt injoignable');
    } finally {
      setBusy(null);
    }
  };

  // Opened from a link (huwa://paperback?repo=…): add that repository right away.
  useEffect(() => {
    if (!params.repo || handled.current === params.repo) return;
    handled.current = params.repo;
    setUrl(params.repo);
    add(params.repo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.repo]);

  const refresh = async (r: RepoEntry) => {
    setBusy(`refresh|${r.url}`);
    try {
      await refreshRepo(r.url);
    } catch (e) {
      Alert.alert(r.name, e instanceof Error ? e.message : 'Dépôt injoignable');
    } finally {
      setBusy(null);
    }
  };

  const visible = (s: RepoSource) =>
    (showAdult || s.contentRating !== 'ADULT') &&
    (!filter.trim() || `${s.name} ${s.language ?? ''} ${s.description}`.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: insets.top + S.sm, paddingHorizontal: S.lg, gap: S.xl, paddingBottom: insets.bottom + S.xxl }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
        <Txt v="display" style={{ fontSize: 26, flexShrink: 1 }} numberOfLines={1}>Extensions manhwa</Txt>
      </View>

      {!extensionsSupported ? (
        <Txt v="body">Les extensions Paperback ne sont disponibles que dans l’app iOS / Android.</Txt>
      ) : (
        <View style={{ gap: S.sm }}>
          <Txt v="small">
            Compatible avec les dépôts d’extensions Paperback 0.8 et 0.9. Colle l’adresse d’un dépôt (ou son lien « Add to Paperback »), puis installe les sources de ton choix.
          </Txt>
          <TextInput
            value={url}
            onChangeText={setUrl}
            onSubmitEditing={() => add()}
            placeholder="https://…/versioning.json ou paperback://addRepo…"
            placeholderTextColor={C.text2}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            accessibilityLabel="Adresse du dépôt"
            style={styles.input}
          />
          {!!error && <Txt v="small" color="#FF8A8A">{error}</Txt>}
          <Button label={busy === 'add' ? 'Chargement du dépôt…' : 'Ajouter le dépôt'} icon="add" onPress={() => add()} />
        </View>
      )}

      {installed.length > 0 && (
        <View style={{ gap: S.md }}>
          <Txt v="section">Sources installées</Txt>
          {installed.map((s) => {
            const update = updateFor(s);
            return (
              <View key={s.key} style={styles.row}>
                <SourceIcon source={s} size={38} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt v="label" numberOfLines={1}>{s.name}</Txt>
                  <Txt v="small" numberOfLines={1} style={{ fontSize: 12 }}>
                    v{s.version} · {s.language?.toUpperCase() ?? '—'} · Paperback {s.format}
                  </Txt>
                  {update && (
                    <Press onPress={() => install(s.repo, s.id)} accessibilityRole="button" accessibilityLabel={`Mettre à jour ${s.name}`}>
                      <Txt v="small" color={C.accentText} style={{ ...F.semibold, fontSize: 12 }}>
                        {busy === `${s.repo}|${s.id}` ? 'Mise à jour…' : `Mettre à jour (v${update.version})`}
                      </Txt>
                    </Press>
                  )}
                </View>
                <Switch value={s.enabled} onValueChange={() => toggleSource(s.key)} trackColor={{ true: C.accent }} accessibilityLabel={`Activer ${s.name}`} />
                <IconButton
                  icon="trash-outline"
                  label={`Supprimer ${s.name}`}
                  size={36}
                  tone="solid"
                  onPress={() =>
                    Alert.alert(`Supprimer ${s.name} ?`, 'Ses réglages et les liens vers ses séries seront effacés. Tes chapitres téléchargés restent lisibles.', [
                      { text: 'Annuler', style: 'cancel' },
                      { text: 'Supprimer', style: 'destructive', onPress: () => uninstallSource(s.key) },
                    ])
                  }
                />
              </View>
            );
          })}
        </View>
      )}

      {repos.length > 0 && (
        <View style={{ gap: S.md }}>
          <Txt v="section">Dépôts</Txt>
          <View style={[styles.row, { paddingVertical: S.sm }]}>
            <Txt v="small" style={{ flex: 1 }}>Afficher les sources pour adultes</Txt>
            <Switch value={showAdult} onValueChange={setShowAdult} trackColor={{ true: C.accent }} accessibilityLabel="Afficher les sources pour adultes" />
          </View>
          {repos.map((r) => {
            const expanded = open === r.url;
            const list = r.sources.filter(visible);
            return (
              <View key={r.url} style={styles.card}>
                <Press onPress={() => setOpen(expanded ? null : r.url)} style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}
                  accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={`${r.name}, ${r.sources.length} sources`}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Txt v="label" numberOfLines={1}>{r.name}</Txt>
                    <Txt v="small" numberOfLines={1} style={{ fontSize: 12 }}>
                      Paperback {r.format} · {r.sources.length} sources · {r.url.replace(/^https?:\/\//, '')}
                    </Txt>
                  </View>
                  <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={C.text2} />
                </Press>
                {expanded && (
                  <View style={{ gap: S.sm }}>
                    <View style={{ flexDirection: 'row', gap: S.sm }}>
                      <Button small variant="ghost" icon="refresh" label={busy === `refresh|${r.url}` ? 'Actualisation…' : 'Actualiser'} style={{ flex: 1 }} onPress={() => refresh(r)} />
                      <Button small variant="ghost" icon="trash-outline" label="Retirer" style={{ flex: 1 }}
                        onPress={() =>
                          Alert.alert(`Retirer ${r.name} ?`, 'Les sources installées depuis ce dépôt seront aussi supprimées.', [
                            { text: 'Annuler', style: 'cancel' },
                            { text: 'Retirer', style: 'destructive', onPress: () => removeRepo(r.url) },
                          ])
                        } />
                    </View>
                    {r.sources.length > 8 && (
                      <TextInput value={filter} onChangeText={setFilter} placeholder="Filtrer les sources" placeholderTextColor={C.text2}
                        autoCorrect={false} autoCapitalize="none" style={[styles.input, { minHeight: 40 }]} accessibilityLabel="Filtrer les sources" />
                    )}
                    {list.map((s) => {
                      const mine = installed.find((x) => x.repo === r.url && x.id === s.id);
                      const working = busy === `${r.url}|${s.id}`;
                      return (
                        <View key={s.id} style={styles.sourceRow}>
                          <View style={{ flex: 1, gap: 2 }}>
                            <Txt v="label" numberOfLines={1} style={{ fontSize: 14 }}>{s.name}</Txt>
                            <Txt v="small" numberOfLines={2} style={{ fontSize: 12 }}>
                              v{s.version} · {s.language?.toUpperCase() ?? '—'} · {RATING[s.contentRating]}
                              {s.description ? ` · ${s.description}` : ''}
                            </Txt>
                          </View>
                          {working ? (
                            <ActivityIndicator color={C.text2} />
                          ) : mine ? (
                            <Ionicons name="checkmark-circle" size={22} color={C.accentText} accessibilityLabel="Installée" />
                          ) : (
                            <Button small variant="soft" label="Installer" onPress={() => install(r.url, s.id)} />
                          )}
                        </View>
                      );
                    })}
                    {!list.length && <Txt v="small">Aucune source à afficher.</Txt>}
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}

      {repos.length > 0 && (
        <Button small variant="soft" icon="share-social-outline" label="Partager mes extensions" onPress={() => router.push('/pack-create')} />
      )}

      {!repos.length && extensionsSupported && (
        <Txt v="small">Aucun dépôt pour l’instant. Huwa n’en fournit pas : ajoute celui de ton choix.</Txt>
      )}

      <Txt v="small" style={{ fontSize: 12 }}>{LEGAL}</Txt>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 48, paddingHorizontal: S.lg, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface,
    color: C.text, ...F.medium, fontSize: 15, borderWidth: 1, borderColor: C.border,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface },
  card: { gap: S.md, padding: S.md, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingVertical: S.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
});
