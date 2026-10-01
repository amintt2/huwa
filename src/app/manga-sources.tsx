// "Extensions manhwa": Paperback extension repositories and sources. Huwa ships none; the user
// adds a repository (URL, `paperback://addRepo…` link or `huwa://paperback?repo=…`) and installs sources.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Card, ExtLogo, hostOf, LinkRow, TrustNote } from '@/components/extension-ui';
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
        <Txt v="display" style={{ fontSize: 26, flexShrink: 1 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} accessibilityRole="header">Extensions manhwa</Txt>
      </View>

      {!extensionsSupported ? (
        <Txt v="body">Les extensions Paperback ne sont disponibles que dans l’app iOS / Android.</Txt>
      ) : (
        <View style={{ gap: S.md }}>
          <Txt v="body" style={{ color: C.body }}>
            Ajoute un dépôt Paperback (0.8 ou 0.9), puis installe les sources de ton choix pour lire leurs chapitres.
          </Txt>
          <View style={styles.field}>
            <Ionicons name="link-outline" size={18} color={C.text2} />
            <TextInput
              value={url}
              onChangeText={(v) => {
                setUrl(v);
                if (error) setError('');
              }}
              onSubmitEditing={() => add()}
              placeholder="https://…/versioning.json ou paperback://…"
              placeholderTextColor="#6F7A90"
              selectionColor={C.accentText}
              keyboardAppearance="dark"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              accessibilityLabel="Adresse du dépôt"
              style={styles.input}
            />
            {busy === 'add' && <ActivityIndicator color={C.accentText} />}
          </View>
          {!!error && (
            <View style={{ flexDirection: 'row', gap: S.sm, alignItems: 'flex-start' }}>
              <Ionicons name="alert-circle-outline" size={16} color="#FF8A8A" style={{ marginTop: 1 }} />
              <Txt v="small" color="#FF8A8A" style={{ flex: 1 }}>{error}</Txt>
            </View>
          )}
          <Button label={busy === 'add' ? 'Chargement du dépôt…' : 'Ajouter le dépôt'} icon="add" onPress={() => add()} />
          <TrustNote text="Huwa n’inclut aucune source : tu choisis tes dépôts. Elles s’exécutent isolées, sans accès à tes données." more={LEGAL} />
        </View>
      )}

      {installed.length > 0 && (
        <View style={{ gap: S.sm }}>
          <Txt v="caption" style={{ paddingHorizontal: S.xs }}>Sources installées ({installed.length})</Txt>
          <Card>
            {installed.map((s, i) => {
              const update = updateFor(s);
              return (
                <View key={s.key} style={[styles.row, i < installed.length - 1 && styles.line]}>
                  <View style={!s.enabled && { opacity: 0.45 }}>
                    <SourceIcon source={s} size={40} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Txt v="label" numberOfLines={1}>{s.name}</Txt>
                    <Txt v="small" numberOfLines={1} style={{ fontSize: 12 }}>
                      {[s.language?.toUpperCase(), `v${s.version}`, `Paperback ${s.format}`].filter(Boolean).join(' · ')}
                    </Txt>
                    {update && (
                      <Press onPress={() => install(s.repo, s.id)} accessibilityRole="button" accessibilityLabel={`Mettre à jour ${s.name}`} hitSlop={6} style={styles.update}>
                        <Ionicons name="arrow-up-circle" size={14} color={C.accentText} />
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
                    size={34}
                    tone="solid"
                    color={C.text2}
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
          </Card>
        </View>
      )}

      {repos.length > 0 && (
        <View style={{ gap: S.sm }}>
          <Txt v="caption" style={{ paddingHorizontal: S.xs }}>Dépôts ({repos.length})</Txt>
          {repos.map((r) => {
            const expanded = open === r.url;
            const list = r.sources.filter(visible);
            const mineCount = installed.filter((x) => x.repo === r.url).length;
            return (
              <Card key={r.url}>
                <Press onPress={() => setOpen(expanded ? null : r.url)} scaleTo={0.99} style={styles.row}
                  accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={`${r.name}, ${r.sources.length} sources`}>
                  <ExtLogo name={r.name} icon="library-outline" size={40} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Txt v="label" numberOfLines={1}>{r.name}</Txt>
                    <Txt v="small" numberOfLines={1} style={{ fontSize: 12 }}>
                      {r.sources.length} sources{mineCount ? ` · ${mineCount} installée${mineCount > 1 ? 's' : ''}` : ''} · {hostOf(r.url)}
                    </Txt>
                  </View>
                  <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={C.text2} />
                </Press>
                {expanded && (
                  <View style={{ gap: S.sm, paddingHorizontal: S.md, paddingBottom: S.md }}>
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
                      <TextInput value={filter} onChangeText={setFilter} placeholder="Filtrer les sources" placeholderTextColor="#6F7A90"
                        keyboardAppearance="dark" autoCorrect={false} autoCapitalize="none" style={[styles.filter]} accessibilityLabel="Filtrer les sources" />
                    )}
                    {list.map((s) => {
                      const mine = installed.find((x) => x.repo === r.url && x.id === s.id);
                      const working = busy === `${r.url}|${s.id}`;
                      return (
                        <View key={s.id} style={styles.sourceRow}>
                          <View style={{ flex: 1, gap: 2 }}>
                            <Txt v="label" numberOfLines={1} style={{ fontSize: 14 }}>{s.name}</Txt>
                            <Txt v="small" numberOfLines={2} style={{ fontSize: 12 }}>
                              {[s.language?.toUpperCase(), `v${s.version}`, RATING[s.contentRating]].filter(Boolean).join(' · ')}
                              {s.description ? ` · ${s.description}` : ''}
                            </Txt>
                          </View>
                          {working ? (
                            <ActivityIndicator color={C.text2} />
                          ) : mine ? (
                            <Ionicons name="checkmark-circle" size={22} color={C.success} accessibilityLabel="Installée" />
                          ) : (
                            <Button small variant="soft" label="Installer" onPress={() => install(r.url, s.id)} />
                          )}
                        </View>
                      );
                    })}
                    {!list.length && <Txt v="small">Aucune source à afficher.</Txt>}
                  </View>
                )}
              </Card>
            );
          })}
          <Card>
            <View style={styles.row}>
              <Txt v="label" style={{ flex: 1, fontSize: 14 }}>Afficher les sources pour adultes</Txt>
              <Switch value={showAdult} onValueChange={setShowAdult} trackColor={{ true: C.accent }} accessibilityLabel="Afficher les sources pour adultes" />
            </View>
          </Card>
        </View>
      )}

      {!repos.length && extensionsSupported && (
        <View style={{ alignItems: 'center', gap: S.md, paddingVertical: S.lg }}>
          <View style={styles.emptyIcon}>
            <Ionicons name="library-outline" size={26} color={C.accentText} />
          </View>
          <Txt v="small" style={{ textAlign: 'center', lineHeight: 19, maxWidth: 300 }}>
            Aucun dépôt pour l’instant. Colle l’adresse d’un dépôt ci-dessus, ou ouvre son lien « Add to Paperback ».
          </Txt>
        </View>
      )}

      {repos.length > 0 && (
        <Card>
          <LinkRow icon="share-social-outline" label="Partager mes extensions" hint="Un pack (lien + QR) avec tes dépôts et sources." last onPress={() => router.push('/pack-create')} />
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: 54, paddingHorizontal: S.md,
    borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.borderStrong,
  },
  input: { flex: 1, minHeight: 52, color: C.text, ...F.medium, fontSize: 15 },
  filter: {
    minHeight: 40, paddingHorizontal: S.md, borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.elevated,
    color: C.text, ...F.medium, fontSize: 14, borderWidth: 1, borderColor: C.border,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md },
  line: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.borderStrong },
  update: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingTop: 2 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingVertical: S.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
  emptyIcon: { width: 56, height: 56, borderRadius: 18, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: C.accentSoft },
});
