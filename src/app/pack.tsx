// Pack confirmation + install: `huwa://pack?d=<payload>` or `huwa://pack?url=<pack JSON URL>`
// (also opened from a pasted / scanned link). Nothing is installed before "Installer".
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAddons } from '@/addons/registry';
import { closeSheet } from '@/components/addon-install';
import { useInstallParam } from '@/components/install-target';
import { CheckGroup, CheckRow, Notice, type RowStatus } from '@/components/pack-rows';
import { SheetTitle } from '@/components/screen';
import { Button, Txt } from '@/components/ui';
import { extensionsSupported, useMangaExt } from '@/manga-ext/registry';
import type { Pack, PackRef } from '@/packs/format';
import { hostOf, installManga, installVideo, loadPack, mangaInstalled, PACK_NOTICE, videoInstalled } from '@/packs/install';
import { C, R, S } from '@/theme/tokens';

const shortUrl = (u: string) => u.replace(/^https?:\/\//i, '').replace(/\/manifest\.json$/i, '');

export default function PackScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ d?: string; url?: string }>();
  const url = useInstallParam('pack', params.url ? String(params.url) : undefined);
  const ref: PackRef | undefined = params.d ? { d: String(params.d) } : url ? { url } : undefined;
  const refKey = ref ? ('d' in ref ? `d:${ref.d}` : `u:${ref.url}`) : '';

  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; pack?: Pack; error?: string }>({ key: '' });
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const addons = useAddons();
  const { repos, installed } = useMangaExt();
  const key = `${attempt}|${refKey}`;

  useEffect(() => {
    if (!ref) return;
    let cancelled = false;
    loadPack(ref)
      .then((pack) => !cancelled && setLoaded({ key, pack }))
      .catch((e) => !cancelled && setLoaded({ key, error: e instanceof Error ? e.message : 'Pack illisible' }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const cur = loaded.key === key ? loaded : { pack: undefined, error: undefined };
  const pack = cur.pack;
  const rows = pack
    ? [
        ...pack.video.map((v) => ({ id: `v|${v.manifest}`, kind: 'video' as const, v })),
        ...pack.manga.map((m) => ({ id: `m|${m.repo}`, kind: 'manga' as const, m })),
      ]
    : [];
  const selected = rows.filter((r) => !unchecked.has(r.id));
  const toggle = (id: string) =>
    phase === 'idle' &&
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const install = async () => {
    if (phase !== 'idle' || !selected.length) return;
    setPhase('running');
    for (const r of selected) {
      setStatus((s) => ({ ...s, [r.id]: { kind: 'busy' } }));
      const res = r.kind === 'video' ? await installVideo(r.v) : await installManga(r.m);
      setStatus((s) => ({ ...s, [r.id]: { kind: res.state, message: res.message } }));
    }
    setPhase('done');
  };

  const results = Object.values(status);
  const count = (k: RowStatus['kind']) => results.filter((s) => s.kind === k).length;

  return (
    <View style={{ flex: 1, backgroundColor: C.surface }}>
      <ScrollView contentContainerStyle={[styles.wrap, { paddingBottom: S.xxl + insets.bottom }]} keyboardShouldPersistTaps="handled">
        <View style={{ marginHorizontal: -S.lg, marginTop: -S.lg }}>
          <SheetTitle title="Pack d’extensions" onClose={closeSheet} />
        </View>

        {!ref && (
          <View style={{ gap: S.md }}>
            <Txt v="label">Lien de pack incomplet : il ne contient ni pack ni adresse.</Txt>
            <Button label="Fermer" onPress={closeSheet} />
          </View>
        )}

        {ref && !pack && !cur.error && (
          <View style={{ alignItems: 'center', gap: S.md, paddingVertical: S.xl }}>
            <ActivityIndicator color={C.accentText} />
            <Txt v="small">{'url' in ref ? `Lecture du pack sur ${hostOf(ref.url)}…` : 'Lecture du pack…'}</Txt>
          </View>
        )}

        {!!cur.error && (
          <View style={{ gap: S.md }}>
            <Txt v="label" color="#FF6B6B">{cur.error}</Txt>
            {ref && 'url' in ref && <Txt v="small" selectable>{ref.url}</Txt>}
            {ref && 'url' in ref && <Button small variant="soft" icon="refresh" label="Réessayer" onPress={() => setAttempt((n) => n + 1)} />}
            <Button small variant="ghost" label="Fermer" onPress={closeSheet} />
          </View>
        )}

        {pack && (
          <>
            <View style={styles.head}>
              <View style={styles.icon}>
                <Ionicons name="albums-outline" size={26} color={C.accentText} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt v="title" numberOfLines={2}>{pack.name}</Txt>
                <Txt v="small">
                  {[pack.author && `par ${pack.author}`, `${rows.length} extension${rows.length > 1 ? 's' : ''}`, ref && 'url' in ref && hostOf(ref.url)].filter(Boolean).join(' · ')}
                </Txt>
              </View>
            </View>
            {!!pack.description && <Txt v="body">{pack.description}</Txt>}

            <Notice text={PACK_NOTICE} />

            {pack.video.length > 0 && (
              <CheckGroup title="VIDÉO · ADDONS STREMIO">
                {pack.video.map((v, i) => {
                  const id = `v|${v.manifest}`;
                  const already = videoInstalled(v, addons);
                  return (
                    <CheckRow
                      key={id}
                      checked={!unchecked.has(id)}
                      onToggle={() => toggle(id)}
                      disabled={phase !== 'idle'}
                      title={v.name ?? hostOf(v.manifest)}
                      subtitle={shortUrl(v.manifest)}
                      badge={already && !status[id] ? 'déjà installé' : undefined}
                      status={status[id]}
                      last={i === pack.video.length - 1}
                    />
                  );
                })}
              </CheckGroup>
            )}

            {pack.manga.length > 0 && (
              <CheckGroup title="MANHWA · DÉPÔTS PAPERBACK">
                {pack.manga.map((m, i) => {
                  const id = `m|${m.repo}`;
                  const already = mangaInstalled(m, repos, installed);
                  const what = m.sources?.length ? `${m.sources.length} source${m.sources.length > 1 ? 's' : ''} : ${m.sources.join(', ')}` : 'Dépôt seul (tu choisiras les sources)';
                  return (
                    <CheckRow
                      key={id}
                      checked={!unchecked.has(id)}
                      onToggle={() => toggle(id)}
                      disabled={phase !== 'idle' || !extensionsSupported}
                      title={m.name ?? hostOf(m.repo)}
                      subtitle={`${shortUrl(m.repo)}\n${what}`}
                      badge={already && !status[id] ? 'déjà installé' : undefined}
                      warning={!extensionsSupported ? 'Indisponible sur le web' : undefined}
                      status={status[id]}
                      last={i === pack.manga.length - 1}
                    />
                  );
                })}
              </CheckGroup>
            )}

            {phase === 'done' ? (
              <View style={{ gap: S.md }}>
                <Txt v="label" style={{ textAlign: 'center' }}>
                  {[
                    count('done') && `${count('done')} installée${count('done') > 1 ? 's' : ''}`,
                    count('already') && `${count('already')} déjà là`,
                    count('failed') && `${count('failed')} en échec`,
                  ].filter(Boolean).join(' · ')}
                </Txt>
                <Button label="Terminé" onPress={closeSheet} />
                <Button small variant="ghost" label="Voir mes extensions" onPress={() => router.replace('/addons' as Href)} />
              </View>
            ) : (
              <View style={{ gap: S.sm }}>
                <Button
                  label={phase === 'running' ? 'Installation…' : `Installer (${selected.length})`}
                  icon="download-outline"
                  onPress={install}
                  style={!selected.length && { opacity: 0.45 }}
                />
                {phase === 'idle' && <Button small variant="ghost" label="Annuler" onPress={closeSheet} />}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, padding: S.lg, gap: S.lg },
  head: { flexDirection: 'row', alignItems: 'center', gap: S.md },
  icon: { width: 52, height: 52, borderRadius: R.card, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: C.accentSoft },
});
