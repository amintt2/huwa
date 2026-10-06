// UI pieces for manga sources (Paperback extensions): source results in search, the "source"
// panel of a manhwa page, and source icons.
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Button, Cover, Press, Txt } from '@/components/ui';
import { palette } from '@/data/anilist';
import type { Series } from '@/data/catalog';
import { useSourceSearch, type SourceResults } from '@/manga-ext/hooks';
import { autoLink, linkManually, probeCandidates, rejectLink, useAutoLink } from '@/manga-ext/autolink';
import { verifySource } from '@/manga-ext/cloudflare';
import { isCloudflareError, sourceErrorText } from '@/manga-ext/cloudflare-core';
import { moveLink, openSourceManga, refreshLinked as refreshLinkedQuiet, refreshLinkedInteractive, searchCatalog, setLinkLang, useSourceLink } from '@/manga-ext/link';
import type { RankedCandidate } from '@/manga-ext/match';
import { getInstalled, useMangaExt, type InstalledSource } from '@/manga-ext/registry';
import type { ExtSearchItem } from '@/manga-ext/validate';
import { isStoreBuild } from '@/config/channel';
import { C, F, R, S } from '@/theme/tokens';

const PLACEHOLDER = palette(null);
const REFRESH_AFTER = 15 * 60e3;

export function SourceIcon({ source, size = 28 }: { source?: Pick<InstalledSource, 'icon'>; size?: number }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size, borderRadius: size * 0.28, borderCurve: 'continuous' as const };
  if (!source?.icon || failed) {
    return (
      <View style={[box, { backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center' }]}>
        <Ionicons name="book-outline" size={size * 0.55} color={C.text2} />
      </View>
    );
  }
  return <Image source={source.icon} style={[box, { backgroundColor: C.elevated }]} onError={() => setFailed(true)} cachePolicy="memory-disk" />;
}

const langLabel = (l: string) => (l === 'unknown' ? '?' : l.toUpperCase());

/** Opens a source result: builds (or reuses) its Huwa page, then navigates to it. */
async function openResult(source: InstalledSource, item: ExtSearchItem, seriesId?: string) {
  const id = await openSourceManga(source.key, item.mangaId, { seriesId, interactive: true });
  router.push(`/manhwa/${id}` as Href);
}

/** Alert for a title that couldn't be opened, with the way out when the site wants a check. */
function openFailed(sourceKey: string, title: string, e: unknown, retry: () => void) {
  if (isCloudflareError(e)) {
    Alert.alert('Vérification Cloudflare requise', `${getInstalled(sourceKey)?.name ?? 'La source'} n’a pas laissé passer la vérification. Réessaie : la page du site va s’ouvrir.`, [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Réessayer', onPress: retry },
    ]);
    return;
  }
  Alert.alert(title, sourceErrorText(e), [
    { text: 'OK', style: 'cancel' },
    { text: 'Réessayer', onPress: retry },
  ]);
}

/**
 * Opening a source title takes a few seconds (details, chapters, AniList match): one at a time,
 * with a busy tile. A Cloudflare block opens the check, then the title opens.
 */
export function useOpenSourceItem() {
  const [opening, setOpening] = useState<string | null>(null);
  const open = async (sourceKey: string, item: Pick<ExtSearchItem, 'mangaId' | 'title'>) => {
    if (opening) return;
    setOpening(`${sourceKey}|${item.mangaId}`);
    try {
      const id = await openSourceManga(sourceKey, item.mangaId, { interactive: true });
      router.push(`/manhwa/${id}` as Href);
    } catch (e) {
      openFailed(sourceKey, item.title, e, () => open(sourceKey, item));
    } finally {
      setOpening(null);
    }
  };
  return { open, isOpening: (sourceKey: string, mangaId: string) => opening === `${sourceKey}|${mangaId}` };
}

/** "Cloudflare" button: opens the site so the user does the check; `onVerified` retries. */
export function CloudflareButton({ sourceKey, url, onVerified, label = 'Cloudflare' }: { sourceKey: string; url?: string; onVerified?: () => void; label?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      small
      variant="soft"
      icon="cloud-outline"
      label={busy ? 'Vérification…' : label}
      disabled={busy}
      accessibilityLabel={`Vérification Cloudflare de ${getInstalled(sourceKey)?.name ?? 'la source'}`}
      onPress={async () => {
        setBusy(true);
        try {
          if ((await verifySource(sourceKey, url)) === 'verified') onVerified?.();
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

/** Error state of a source screen: Cloudflare check needed, or source unreachable, with "Réessayer". */
export function SourceErrorState({ sourceKey, error, blocked, onRetry }: { sourceKey: string; error?: string; blocked?: { url?: string }; onRetry: () => void }) {
  const name = getInstalled(sourceKey)?.name ?? 'Cette source';
  return (
    <View style={styles.state} accessibilityRole="summary">
      <View style={styles.stateIcon}>
        <Ionicons name={blocked ? 'cloud-outline' : 'cloud-offline-outline'} size={26} color={C.accentText} />
      </View>
      <Txt v="label" style={{ textAlign: 'center' }}>{blocked ? 'Vérification Cloudflare requise' : 'Source injoignable'}</Txt>
      <Txt v="small" style={{ textAlign: 'center', maxWidth: 320 }}>
        {blocked
          ? `${name} protège son site avec Cloudflare. Touche Cloudflare, coche la vérification sur la page du site, puis touche Terminé.`
          : error || `${name} ne répond pas pour l’instant.`}
      </Txt>
      <View style={{ flexDirection: 'row', gap: S.sm, marginTop: S.sm }}>
        {blocked && <CloudflareButton sourceKey={sourceKey} url={blocked.url} onVerified={onRetry} />}
        <Button small variant={blocked ? 'ghost' : 'soft'} icon="refresh" label="Réessayer" onPress={onRetry} />
      </View>
    </View>
  );
}

function ResultCard({ source, item, width, busy, onPress, headers }: { source: InstalledSource; item: ExtSearchItem; width: number; busy: boolean; onPress: () => void; headers?: Record<string, string> }) {
  return (
    <Press onPress={onPress} style={{ width, gap: 6 }} accessibilityRole="button" accessibilityLabel={`${item.title}, ${source.name}`}>
      <Cover palette={PLACEHOLDER} image={item.image} imageHeaders={headers} width={width} height={width * 1.42}>
        {busy && (
          <View style={[StyleSheet.absoluteFill, styles.busy]}>
            <ActivityIndicator color={C.text} />
          </View>
        )}
      </Cover>
      <Txt v="caption" color={C.text} numberOfLines={2} style={{ fontSize: 11, lineHeight: 14, letterSpacing: 0.3 }}>{item.title}</Txt>
    </Press>
  );
}

/** "Dans tes sources" block of the search screen: one rail per installed source. */
export function SourceResultsRail({ query, cardWidth }: { query: string; cardWidth: number }) {
  const rows = useSourceSearch(query);
  const [opening, setOpening] = useState<string | null>(null);
  if (!rows.length) return null;

  const open = async (r: SourceResults, item: ExtSearchItem) => {
    if (opening) return;
    setOpening(`${r.source.key}|${item.mangaId}`);
    try {
      await openResult(r.source, item);
    } catch (e) {
      openFailed(r.source.key, item.title, e, () => open(r, item));
    } finally {
      setOpening(null);
    }
  };

  return (
    <View style={{ gap: S.md, paddingBottom: S.md }}>
      <Txt v="caption" style={{ paddingHorizontal: S.lg }}>Dans tes sources</Txt>
      {rows.map((r) => (
        <View key={r.source.key} style={{ gap: S.sm }}>
          <View style={styles.railHead}>
            <SourceIcon source={r.source} size={20} />
            <Txt v="label" style={{ fontSize: 14, flexShrink: 1 }} numberOfLines={1}>{r.source.name}</Txt>
            {r.state === 'loading' && <ActivityIndicator size="small" color={C.text2} />}
            {r.state === 'ok' && <Txt v="small" style={{ fontSize: 12 }}>{r.items.length ? `${r.items.length} résultat${r.items.length > 1 ? 's' : ''}` : 'Aucun résultat'}</Txt>}
          </View>
          {r.state === 'error' && (
            <View style={styles.inlineError}>
              <Txt v="small" style={{ flex: 1, fontSize: 12 }} numberOfLines={2}>{r.blocked ? 'Le site demande une vérification Cloudflare.' : r.error}</Txt>
              {r.blocked && <CloudflareButton sourceKey={r.source.key} url={r.blocked.url} onVerified={r.retry} />}
            </View>
          )}
          {r.items.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: S.lg, gap: S.md }} keyboardShouldPersistTaps="handled">
              {r.items.map((item) => (
                <ResultCard key={item.mangaId} source={r.source} item={item} width={cardWidth} busy={opening === `${r.source.key}|${item.mangaId}`} headers={r.imageHeaders} onPress={() => open(r, item)} />
              ))}
            </ScrollView>
          )}
        </View>
      ))}
    </View>
  );
}

/** Source panel of a manhwa page: linked source (refresh, language, change, unlink) or automatic search. */
export function SourcePanel({ series }: { series: Series }) {
  const link = useSourceLink(series.id);
  const { installed } = useMangaExt();
  const auto = useAutoLink(series.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);
  const [associating, setAssociating] = useState(false);
  const source = link ? getInstalled(link.key) : undefined;
  const hasSources = installed.some((s) => s.enabled);

  const refresh = async (quiet = false) => {
    if (busy || !link) return;
    // The automatic refresh of a stale list never pops the Cloudflare page by itself.
    if (quiet) {
      refreshLinkedQuiet(series.id).catch(() => {});
      return;
    }
    setBusy(true);
    setError('');
    try {
      await refreshLinkedInteractive(series.id);
    } catch (e) {
      setError(isCloudflareError(e) ? 'Vérification Cloudflare non terminée : chapitres non actualisés.' : sourceErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  // Stale chapter list: refresh quietly when the page opens.
  const updatedAt = link?.updatedAt;
  useEffect(() => {
    if (updatedAt === undefined || Date.now() - updatedAt < REFRESH_AFTER) return;
    const t = setTimeout(() => refresh(true), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.id, updatedAt]);

  // Not linked yet: look for the series in the installed sources.
  const linked = !!link;
  useEffect(() => {
    if (linked || !hasSources) return;
    const t = setTimeout(() => autoLink(series.id).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [series.id, linked, hasSources]);

  if (associating) {
    return (
      <View style={styles.panel}>
        <CatalogPicker series={series} onClose={() => setAssociating(false)} />
      </View>
    );
  }

  if (picking) {
    return (
      <View style={styles.panel}>
        <LinkPicker series={series} candidates={auto.match?.candidates ?? []} current={link ? `${link.key}|${link.mangaId}` : undefined} onClose={() => setPicking(false)} />
      </View>
    );
  }

  if (link) {
    const count = series.manhwa?.chapters.length ?? 0;
    return (
      <View style={styles.panel}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
          <SourceIcon source={source} size={34} />
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="label" numberOfLines={1}>{source ? `Lié à ${source.name}` : 'Source supprimée'}</Txt>
            <Txt v="small" numberOfLines={1} style={{ fontSize: 12 }}>
              {count} ch. · {langLabel(link.lang)}
              {link.title !== series.title ? ` · « ${link.title} »` : ''}
            </Txt>
          </View>
          {busy ? (
            <ActivityIndicator color={C.text2} />
          ) : (
            <Press onPress={() => refresh()} style={styles.round} accessibilityLabel="Actualiser les chapitres">
              <Ionicons name="refresh" size={18} color={C.text} />
            </Press>
          )}
          <Press
            onPress={() =>
              Alert.alert('Délier la source ?', 'Les chapitres de la source ne seront plus affichés sur cette page, et ce titre ne sera plus proposé automatiquement.', [
                { text: 'Annuler', style: 'cancel' },
                { text: 'Délier', style: 'destructive', onPress: () => rejectLink(series.id) },
              ])
            }
            style={styles.round}
            accessibilityLabel="Délier la source">
            <Ionicons name="unlink-outline" size={18} color={C.text} />
          </Press>
        </View>
        {link.langs.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: S.sm }}>
            {link.langs.map((l) => {
              const on = l === link.lang;
              return (
                <Press key={l} onPress={() => setLinkLang(series.id, l)} accessibilityRole="button" accessibilityState={{ selected: on }}
                  style={[styles.lang, on && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
                  <Txt v="caption" color={on ? C.accentText : C.text2}>{langLabel(l)}</Txt>
                </Press>
              );
            })}
          </ScrollView>
        )}
        <View style={{ flexDirection: 'row', gap: S.lg, flexWrap: 'wrap' }}>
          <Pressable onPress={() => setPicking(true)} hitSlop={8} accessibilityRole="button" style={styles.link}>
            <Txt v="small" color={C.accentText} style={{ fontSize: 12, ...F.semibold }}>{series.id.startsWith('px') ? 'Changer de titre source' : 'Ce n’est pas le bon ?'}</Txt>
          </Pressable>
          {series.id.startsWith('px') ? (
            <Pressable onPress={() => setAssociating(true)} hitSlop={8} accessibilityRole="button" style={styles.link}>
              <Txt v="small" color={C.accentText} style={{ fontSize: 12, ...F.semibold }}>Associer à une fiche Huwa</Txt>
            </Pressable>
          ) : null}
        </View>
        {series.id.startsWith('px') && !associating && (
          <Txt v="small" style={{ fontSize: 12 }}>Page de la source seule : associe-la à sa fiche Huwa pour retrouver l’anime, les notes et la communauté.</Txt>
        )}
        {!!error && <Txt v="small" color="#FF8A8A" style={{ fontSize: 12 }}>{error}</Txt>}
      </View>
    );
  }

  if (!hasSources) {
    // App Store flavor: no extensions to add.
    if (isStoreBuild) return null;
    return (
      <Press onPress={() => router.push('/manga-sources' as Href)} style={[styles.panel, { flexDirection: 'row', alignItems: 'center', gap: S.md }]}
        accessibilityRole="button" accessibilityLabel="Ajouter des extensions manhwa">
        <Ionicons name="extension-puzzle-outline" size={20} color={C.accentText} />
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="label" style={{ fontSize: 14 }}>Lire les vrais chapitres</Txt>
          <Txt v="small" style={{ fontSize: 12 }}>Ajoute un dépôt d’extensions Paperback et installe tes sources.</Txt>
        </View>
        <Ionicons name="chevron-forward" size={16} color={C.text2} />
      </Press>
    );
  }

  const searching = auto.status === 'searching';
  const proposals = (auto.match?.candidates ?? []).filter((c) => !auto.match?.rejected.includes(`${c.sourceKey}|${c.mangaId}`));
  const top = proposals[0];
  return (
    <View style={styles.panel}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        {searching ? <ActivityIndicator color={C.text2} /> : <Ionicons name="search" size={18} color={C.text2} />}
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="label" style={{ fontSize: 14 }}>{searching ? 'Recherche dans tes sources…' : 'Pas encore lié à une source'}</Txt>
          {!searching && (
            <Txt v="small" style={{ fontSize: 12 }}>
              {proposals.length ? `${proposals.length} titre${proposals.length > 1 ? 's' : ''} proche${proposals.length > 1 ? 's' : ''} trouvé${proposals.length > 1 ? 's' : ''}` : auto.blocked ? 'Une source demande une vérification' : 'Aucune correspondance sûre'}
            </Txt>
          )}
        </View>
        {!searching && <Button small variant="soft" label="Choisir" onPress={() => setPicking(true)} />}
      </View>
      {!searching && top && <Suggestion seriesId={series.id} candidate={top} />}
      {!searching && auto.blocked && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
          <Txt v="small" style={{ flex: 1, fontSize: 12 }}>{getInstalled(auto.blocked.sourceKey)?.name ?? 'Une source'} demande une vérification Cloudflare.</Txt>
          <CloudflareButton sourceKey={auto.blocked.sourceKey} url={auto.blocked.url} onVerified={() => autoLink(series.id, { force: true }).catch(() => {})} />
        </View>
      )}
    </View>
  );
}

/** "Trouvé dans Asura Scans · 98 ch.": best proposal below the automatic threshold, one tap to link. */
function Suggestion({ seriesId, candidate: c }: { seriesId: string; candidate: RankedCandidate }) {
  const [busy, setBusy] = useState(false);
  const ref = `${c.sourceKey}|${c.mangaId}`;
  // Chapter count of the best proposals, fetched once in the background (cached with them).
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => probeCandidates(seriesId, 2, () => cancelled).catch(() => {}), 600);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [seriesId, ref]);
  const name = getInstalled(c.sourceKey)?.name ?? 'une source';
  const link = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await linkManually(seriesId, c);
    } catch (e) {
      Alert.alert(c.title, sourceErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.pickRow}>
      <Cover palette={PLACEHOLDER} image={c.image} width={40} height={56} radius={8} />
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="small" style={{ fontSize: 12 }} numberOfLines={1}>Trouvé dans {name}{c.chapters !== undefined ? ` · ${c.chapters} ch.` : ''}</Txt>
        <Txt v="label" numberOfLines={2} style={{ fontSize: 14 }}>{c.title}</Txt>
      </View>
      {busy ? <ActivityIndicator color={C.text2} /> : <Button small variant="soft" icon="link" label="Lier" onPress={link} accessibilityLabel={`Lier ${c.title} de ${name}`} />}
    </View>
  );
}

/** "Associer à une fiche Huwa": AniList search, the chosen page takes over the source link. */
function CatalogPicker({ series, onClose }: { series: Series; onClose: () => void }) {
  const [query, setQuery] = useState(series.title);
  const [state, setState] = useState<{ loading: boolean; items: { media: { id: number }; series: Series }[]; error?: string }>({ loading: true, items: [] });
  const [moving, setMoving] = useState<string | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setState((s) => ({ ...s, loading: true, error: undefined }));
      searchCatalog(q, ctrl.signal).then(
        (items) => setState({ loading: false, items }),
        (e) => !ctrl.signal.aborted && setState({ loading: false, items: [], error: e instanceof Error ? e.message : 'Recherche impossible' }),
      );
    }, 400);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);
  const pick = async (target: Series) => {
    if (moving) return;
    setMoving(target.id);
    try {
      const id = await moveLink(series.id, target);
      onClose();
      router.replace(`/manhwa/${id}` as Href);
    } catch (e) {
      Alert.alert(target.title, e instanceof Error ? e.message : 'Association impossible');
    } finally {
      setMoving(null);
    }
  };
  return (
    <View style={{ gap: S.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Txt v="caption">Associer à une fiche Huwa</Txt>
        <Press onPress={onClose} hitSlop={10} accessibilityLabel="Fermer">
          <Ionicons name="close" size={18} color={C.text2} />
        </Press>
      </View>
      <TextInput value={query} onChangeText={setQuery} placeholder="Titre sur AniList" placeholderTextColor={C.text2} style={styles.input} autoCorrect={false} accessibilityLabel="Rechercher une fiche Huwa" />
      {state.loading && <ActivityIndicator color={C.text2} />}
      {!!state.error && <Txt v="small" style={{ fontSize: 12 }}>{state.error}</Txt>}
      {!state.loading && !state.error && !state.items.length && <Txt v="small" style={{ fontSize: 12 }}>Aucune fiche trouvée</Txt>}
      {state.items.slice(0, 6).map(({ series: s }) => (
        <Press key={s.id} onPress={() => pick(s)} style={styles.pickRow} accessibilityRole="button" accessibilityLabel={`Associer à ${s.title}`}>
          <Cover palette={s.palette} image={s.image} width={40} height={56} radius={8} />
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="label" numberOfLines={2} style={{ fontSize: 14 }}>{s.title}</Txt>
            <Txt v="small" numberOfLines={1} style={{ fontSize: 12 }}>{[s.year || '', s.anime ? 'Anime + manhwa' : 'Manhwa', s.manhwa?.chapters.length ? `${s.manhwa.chapters.length} ch.` : ''].filter(Boolean).join(' · ')}</Txt>
          </View>
          {moving === s.id ? <ActivityIndicator color={C.text2} /> : <Ionicons name="git-merge-outline" size={18} color={C.accentText} />}
        </Press>
      ))}
    </View>
  );
}

/** Pick the right title: ranked candidates first, then a live search in every source. */
function LinkPicker({ series, candidates, current, onClose }: { series: Series; candidates: RankedCandidate[]; current?: string; onClose: () => void }) {
  const [query, setQuery] = useState(series.title);
  const rows = useSourceSearch(query, true, 400);
  const [opening, setOpening] = useState<string | null>(null);
  const pick = async (sourceKey: string, item: { mangaId: string; title: string }) => {
    if (opening) return;
    setOpening(`${sourceKey}|${item.mangaId}`);
    try {
      await linkManually(series.id, { sourceKey, mangaId: item.mangaId });
      onClose();
    } catch (e) {
      Alert.alert(item.title, e instanceof Error ? e.message : 'Impossible de lier ce titre');
    } finally {
      setOpening(null);
    }
  };
  const row = (sourceKey: string, item: { mangaId: string; title: string; subtitle?: string; image?: string }, headers?: Record<string, string>, score?: number) => {
    const id = `${sourceKey}|${item.mangaId}`;
    const busy = opening === id;
    const isCurrent = id === current;
    return (
      <Press key={id} onPress={() => !isCurrent && pick(sourceKey, item)} style={styles.pickRow} accessibilityRole="button" accessibilityLabel={`Lier ${item.title}`}>
        <Cover palette={PLACEHOLDER} image={item.image} imageHeaders={headers} width={40} height={56} radius={8} />
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="label" numberOfLines={2} style={{ fontSize: 14 }}>{item.title}</Txt>
          <Txt v="small" numberOfLines={1} style={{ fontSize: 12 }}>
            {[getInstalled(sourceKey)?.name, item.subtitle, score !== undefined ? `${Math.round(score * 100)} %` : ''].filter(Boolean).join(' · ')}
          </Txt>
        </View>
        {busy ? <ActivityIndicator color={C.text2} /> : isCurrent ? <Ionicons name="checkmark-circle" size={18} color={C.success} /> : <Ionicons name="link" size={16} color={C.accentText} />}
      </Press>
    );
  };
  return (
    <View style={{ gap: S.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Txt v="caption">Choisis le bon titre</Txt>
        <Press onPress={onClose} hitSlop={10} accessibilityLabel="Fermer">
          <Ionicons name="close" size={18} color={C.text2} />
        </Press>
      </View>
      {candidates.length > 0 && (
        <View style={{ gap: S.sm }}>
          <Txt v="small" style={{ ...F.semibold, fontSize: 13 }}>Meilleures correspondances</Txt>
          {candidates.slice(0, 5).map((c) => row(c.sourceKey, c, undefined, c.score))}
        </View>
      )}
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Rechercher un autre titre"
        placeholderTextColor={C.text2}
        style={styles.input}
        autoCorrect={false}
        accessibilityLabel="Rechercher dans mes sources"
      />
      {rows.map((r) => (
        <View key={r.source.key} style={{ gap: S.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
            <SourceIcon source={r.source} size={18} />
            <Txt v="small" style={{ ...F.semibold, fontSize: 13 }}>{r.source.name}</Txt>
            {r.state === 'loading' && <ActivityIndicator size="small" color={C.text2} />}
          </View>
          {r.state === 'error' && <Txt v="small" style={{ fontSize: 12 }}>{r.error}</Txt>}
          {r.state === 'ok' && !r.items.length && <Txt v="small" style={{ fontSize: 12 }}>Aucun résultat</Txt>}
          {r.items.slice(0, 5).map((item) => row(r.source.key, item, r.imageHeaders))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  busy: { backgroundColor: 'rgba(5,7,13,0.55)', alignItems: 'center', justifyContent: 'center' },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: S.sm, paddingHorizontal: S.xl, paddingBottom: 80 },
  stateIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: C.accentSoft, alignItems: 'center', justifyContent: 'center', marginBottom: S.xs },
  inlineError: { flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingHorizontal: S.lg },
  railHead: { flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingHorizontal: S.lg },
  panel: { gap: S.md, padding: S.md, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  round: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center' },
  lang: { minHeight: 30, minWidth: 44, paddingHorizontal: S.md, alignItems: 'center', justifyContent: 'center', borderRadius: R.control, borderWidth: 1, borderColor: C.border, backgroundColor: C.elevated },
  link: { alignSelf: 'flex-start', minHeight: 28, justifyContent: 'center' },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingVertical: 4 },
  input: {
    minHeight: 40, paddingHorizontal: S.md, borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.elevated,
    borderWidth: 1, borderColor: C.border, color: C.text, ...F.regular, fontSize: 14,
  },
});
