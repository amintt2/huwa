import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BridgeToAnime } from '@/components/bridge';
import { ListsButton } from '@/components/lists';
import { SourcePanel } from '@/components/paperback';
import {
  downloadChapter,
  downloadLabel,
  downloadNext,
  downloadSeries,
  downloadsSupported,
  formatBytes,
  pauseDownload,
  removeDownload,
  removeSeriesDownloads,
  resumeDownload,
  useDownloadQueue,
  useDownloads,
  type DownloadEntry,
} from '@/components/reader/downloads';
import { isDemo } from '@/demo/flags';
import { useSourceLink } from '@/manga-ext/link';
import { Button, Chip, Cover, IconButton, Press, Progress, Txt } from '@/components/ui';
import { episodeForChapter } from '@/data/bridge';
import { getSeries, type Chapter } from '@/data/catalog';
import { toggleMyList, useStore } from '@/store/store';
import { C, F, S } from '@/theme/tokens';

export default function ManhwaDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const series = getSeries(id);
  const chapters = useStore((s) => s.chapters);
  const episodes = useStore((s) => s.episodes);
  const inList = useStore((s) => s.myList.includes(id));
  const [newestFirst, setNewestFirst] = useState(true);
  // Covers of a source-only page may need the source's headers (Referer).
  const coverHeaders = useSourceLink(id)?.imageHeaders;
  const downloads = useDownloads();
  const linked = !!useSourceLink(id);
  // Only real pages are kept offline: chapters of a linked source (or the demo catalog).
  const canDownload = downloadsSupported && (isDemo || linked);
  const { blocked } = useDownloadQueue();

  const list = useMemo(() => {
    const all = series?.manhwa?.chapters ?? [];
    return newestFirst ? [...all].reverse() : all;
  }, [series, newestFirst]);

  if (!series?.manhwa) return <Txt style={{ padding: S.xl }}>Manhwa introuvable.</Txt>;
  const all = series.manhwa.chapters;

  // Resume: chapter in progress, else first unread chapter after what you read or watched.
  const inProgress = all.find((c) => chapters[c.id] && !chapters[c.id].done);
  const lastRead = [...all].reverse().find((c) => chapters[c.id]?.done)?.number ?? 0;
  const lastWatched = Math.max(0, ...(series.anime?.episodes.filter((e) => episodes[e.id]?.done).map((e) => e.chapters[1]) ?? []));
  // By number, not position: chapters from a source can start at 0 or skip numbers.
  const after = Math.max(lastRead, lastWatched);
  const resume = inProgress ?? all.find((c) => c.number > after) ?? all[all.length - 1];

  const seriesDl = Object.values(downloads).filter((d) => d.seriesId === series.id);
  const dlDone = seriesDl.filter((d) => d.status === 'done');
  const dlBytes = dlDone.reduce((n, d) => n + (d.bytes || 0), 0);

  const menu = (title: string, options: { label: string; destructive?: boolean; run: () => void }[]) => {
    if (Platform.OS === 'ios') {
      const destructiveButtonIndex = options.findIndex((o) => o.destructive);
      ActionSheetIOS.showActionSheetWithOptions(
        { title, options: [...options.map((o) => o.label), 'Annuler'], cancelButtonIndex: options.length, destructiveButtonIndex: destructiveButtonIndex >= 0 ? destructiveButtonIndex : undefined, userInterfaceStyle: 'dark' },
        (i) => options[i]?.run(),
      );
    } else {
      Alert.alert(title, undefined, [...options.map((o) => ({ text: o.label, style: o.destructive ? ('destructive' as const) : undefined, onPress: o.run })), { text: 'Annuler', style: 'cancel' as const }]);
    }
  };

  const downloadMenu = () => {
    const start = resume ?? all[0];
    const left = all.length - dlDone.length;
    menu('Télécharger', [
      ...(start ? [{ label: `Les 5 prochains (dès le ch. ${start.number})`, run: () => downloadNext(series.id, start.id, 5) }] : []),
      ...(start ? [{ label: `Les 20 prochains`, run: () => downloadNext(series.id, start.id, 20) }] : []),
      ...(left > 0 ? [{ label: `Toute la série (${left} ch.)`, run: () => downloadSeries(series.id, all.map((c) => c.id)) }] : []),
      ...(seriesDl.length ? [{ label: dlBytes ? `Supprimer les téléchargements (${formatBytes(dlBytes)})` : 'Supprimer les téléchargements', destructive: true, run: () => removeSeriesDownloads(series.id) }] : []),
      { label: 'Gérer les téléchargements', run: () => router.push('/offline') },
    ]);
  };

  const chapterMenu = (c: Chapter, d?: DownloadEntry) =>
    menu(`Chapitre ${c.number}`, [
      ...(!d || d.status === 'error' ? [{ label: 'Télécharger ce chapitre', run: () => (d ? resumeDownload(c.id) : downloadChapter(c.id, series.id)) }] : []),
      { label: 'Télécharger les 5 suivants', run: () => downloadNext(series.id, c.id, 5) },
      ...(d && (d.status === 'queued' || d.status === 'downloading') ? [{ label: 'Mettre en pause', run: () => pauseDownload(c.id) }] : []),
      ...(d?.status === 'paused' ? [{ label: 'Reprendre', run: () => resumeDownload(c.id) }] : []),
      ...(d ? [{ label: d.status === 'done' ? 'Supprimer le téléchargement' : 'Annuler le téléchargement', destructive: true, run: () => removeDownload(c.id) }] : []),
    ]);

  const onBadge = (c: Chapter, d?: DownloadEntry) => {
    if (!d) downloadChapter(c.id, series.id);
    else if (d.status === 'queued' || d.status === 'downloading') pauseDownload(c.id);
    else if (d.status === 'paused' || d.status === 'error') resumeDownload(c.id);
    else chapterMenu(c, d);
  };

  const renderRow = ({ item: c }: { item: Chapter }) => {
    const p = chapters[c.id];
    const d = downloads[c.id];
    const ep = episodeForChapter(series, c.number);
    const seenInAnime = !!ep && !!episodes[ep.id]?.done;
    const muted = p?.done || seenInAnime;
    return (
      <Press onPress={() => router.push(`/read/${c.id}`)} onLongPress={canDownload || d ? () => chapterMenu(c, d) : undefined} style={styles.row} accessibilityLabel={`Chapitre ${c.number}${d ? `, ${downloadLabel(d, blocked)}` : ''}`}>
        <View style={[styles.num, muted && { backgroundColor: 'transparent' }]}>
          <Txt v="label" color={muted ? C.text2 : C.text} style={{ fontSize: c.number >= 1000 ? 13 : 16, ...F.heavy }} numberOfLines={1} adjustsFontSizeToFit>
            {Number.isInteger(c.number) ? c.number : c.number.toFixed(1)}
          </Txt>
          {p?.done && <Ionicons name="checkmark" size={11} color={C.text2} />}
        </View>
        <View style={{ flex: 1, gap: 4, opacity: muted ? 0.6 : 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm, flexWrap: 'wrap' }}>
            <Txt v="label" color={muted ? C.text2 : C.text}>Chapitre {c.number}</Txt>
            {c.releasedDaysAgo === 0 && (
              <View style={styles.new}><Txt v="caption" color={C.onAccent} style={{ fontSize: 9 }}>NOUVEAU</Txt></View>
            )}
            {ep && seenInAnime && <Chip kind="anime" label={`VU EN ANIME · ÉP. ${ep.number}`} />}
          </View>
          {p && !p.done ? (
            <>
              <Txt v="small" color={C.accent} style={{ ...F.semibold }}>En cours · {Math.round(p.ratio * 100)} %</Txt>
              <Progress value={p.ratio} color={C.accent} />
            </>
          ) : (
            <Txt v="small">
              {p?.done ? 'Lu' : c.releasedDaysAgo < 0 ? (c.title || 'Chapitre') : c.releasedDaysAgo === 0 ? 'Aujourd’hui' : `il y a ${c.releasedDaysAgo} j`}
              {ep && !seenInAnime ? ` · adapté dans l’ép. ${ep.number}` : ''}
            </Txt>
          )}
        </View>
        {(canDownload || d) && <DownloadBadge entry={d} label={downloadLabel(d, blocked)} onPress={() => onBadge(c, d)} />}
      </Press>
    );
  };

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: C.bg }}
      data={list}
      keyExtractor={(c) => c.id}
      renderItem={renderRow}
      extraData={downloads}
      initialNumToRender={12}
      contentContainerStyle={{ paddingBottom: insets.bottom + S.xxl, gap: S.md }}
      ListHeaderComponent={
        <View style={{ gap: S.lg, paddingBottom: S.xs }}>
          <View style={{ height: 350 }}>
            <Cover palette={series.palette} image={series.image} imageHeaders={series.id.startsWith('px') ? coverHeaders : undefined} height={350} radius={0} dim style={StyleSheet.absoluteFill} />
            <View style={[styles.nav, { top: insets.top + S.sm }]}>
              <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
            </View>
            <View style={styles.info}>
              <Cover palette={series.palette} image={series.image} imageHeaders={series.id.startsWith('px') ? coverHeaders : undefined} width={128} height={190} radius={14} />
              <View style={{ flex: 1, gap: S.sm }}>
                <Chip kind="manhwa" />
                <Txt v="title" style={{ fontSize: 24, lineHeight: 28 }}>{series.title}</Txt>
                <Txt v="small" style={{ fontSize: 13 }}>{series.author}</Txt>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: series.status === 'ongoing' ? C.success : C.text2 }} />
                  <Txt v="small">{series.status === 'ongoing' ? 'En cours' : 'Terminé'} · {all.length} ch.</Txt>
                </View>
              </View>
            </View>
          </View>

          <View style={{ paddingHorizontal: S.lg, gap: S.lg }}>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button
                style={{ flex: 1 }}
                color={C.accent}
                textColor={C.onAccent}
                label={!resume ? 'Aucun chapitre' : inProgress || lastRead ? `Continuer · Ch. ${resume.number}` : `Lire · Ch. ${resume.number}`}
                onPress={() => resume && router.push(`/read/${resume.id}`)}
              />
              <Press onPress={() => toggleMyList(series.id)} style={styles.square} accessibilityLabel={inList ? 'Retirer de ma liste' : 'Ajouter à ma liste'}>
                <Ionicons name={inList ? 'checkmark' : 'add'} size={24} color={C.text} />
              </Press>
              <ListsButton seriesId={series.id} />
              {canDownload && (
                <Press onPress={downloadMenu} style={styles.square} accessibilityLabel="Télécharger des chapitres">
                  <Ionicons name="arrow-down-circle-outline" size={24} color={C.text} />
                </Press>
              )}
            </View>
            <SourcePanel series={series} />
            <Txt v="body">{series.synopsis}</Txt>
            {series.anime && <BridgeToAnime series={series} />}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ gap: 2 }}>
                <Txt v="section" style={{ fontSize: 17 }}>{all.length} chapitres</Txt>
                {dlDone.length > 0 && (
                  <Txt v="small" style={{ fontSize: 12 }}>{dlDone.length} hors-ligne · {formatBytes(dlBytes)}</Txt>
                )}
              </View>
              <Pressable onPress={() => setNewestFirst((v) => !v)} hitSlop={10} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44 }}>
                <Txt v="small" style={{ fontSize: 13, ...F.medium }}>{newestFirst ? 'Plus récents' : 'Plus anciens'}</Txt>
                <Ionicons name="swap-vertical" size={14} color={C.text2} />
              </Pressable>
            </View>
          </View>
        </View>
      }
    />
  );
}

/** Trailing download state of a chapter row: tap to download / pause / resume. */
function DownloadBadge({ entry: d, label, onPress }: { entry?: DownloadEntry; label?: string; onPress: () => void }) {
  const pct = d && d.total ? d.saved / d.total : 0;
  const icon =
    !d ? 'arrow-down-circle-outline' : d.status === 'done' ? 'checkmark-circle' : d.status === 'paused' ? 'pause-circle-outline' : d.status === 'error' ? 'alert-circle-outline' : null;
  return (
    <Pressable onPress={onPress} hitSlop={8} style={styles.badge} accessibilityRole="button" accessibilityLabel={label ?? 'Télécharger'}>
      {icon ? (
        <Ionicons name={icon} size={22} color={d?.status === 'done' ? C.accentText : d?.status === 'error' ? '#FF8A8A' : C.text2} />
      ) : (
        <View style={styles.ring}>
          <Txt v="caption" color={C.accentText} style={{ fontSize: 9 }}>{d?.status === 'downloading' ? `${Math.round(pct * 100)}` : '…'}</Txt>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  num: {
    width: 48, height: 48, borderRadius: 12, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border,
  },
  ring: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: C.accentLine, alignItems: 'center', justifyContent: 'center' },
  nav: { position: 'absolute', left: S.lg },
  info: { position: 'absolute', left: S.lg, right: S.lg, bottom: S.md, flexDirection: 'row', alignItems: 'flex-end', gap: S.lg },
  square: { width: 52, height: 52, borderRadius: 16, backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg },
  new: { paddingVertical: 2, paddingHorizontal: 6, borderRadius: 5, backgroundColor: C.accent },
});
