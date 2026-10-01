import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';
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
import { DetailBackdrop, DetailNav, DetailTabs, Synopsis } from '@/components/detail';
import { ActionTile, Button, Chip, MetaLine, Press, Progress, Txt } from '@/components/ui';
import { episodeForChapter } from '@/data/bridge';
import { getSeries, type Chapter } from '@/data/catalog';
import { toggleMyList, useStore } from '@/store/store';
import { C, F, R, S, TABULAR } from '@/theme/tokens';

export default function ManhwaDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const series = getSeries(id);
  const chapters = useStore((s) => s.chapters);
  const episodes = useStore((s) => s.episodes);
  const inList = useStore((s) => s.myList.includes(id));
  const [newestFirst, setNewestFirst] = useState(true);
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({ onScroll: (e) => { scrollY.set(e.contentOffset.y); } });
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
      <Press onPress={() => router.push(`/read/${c.id}`)} onLongPress={canDownload || d ? () => chapterMenu(c, d) : undefined} scaleTo={0.98} style={styles.row} accessibilityLabel={`Chapitre ${c.number}${p?.done ? ', lu' : ''}${d ? `, ${downloadLabel(d, blocked)}` : ''}`}>
        <View style={[styles.num, muted && styles.numMuted, c.id === resume?.id && !muted && styles.numNext]}>
          <Text maxFontSizeMultiplier={1.2} style={[styles.numText, { fontSize: c.number >= 1000 ? 13 : 16 }, muted && { color: C.text3 }]} numberOfLines={1} adjustsFontSizeToFit>
            {Number.isInteger(c.number) ? c.number : c.number.toFixed(1)}
          </Text>
          {p?.done && <Ionicons name="checkmark" size={11} color={C.text3} />}
        </View>
        <View style={{ flex: 1, gap: 4, opacity: muted ? 0.6 : 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm, flexWrap: 'wrap' }}>
            <Txt v="label" color={muted ? C.text2 : C.text}>Chapitre {c.number}</Txt>
            {c.releasedDaysAgo === 0 && (
              <View style={styles.new}><Text maxFontSizeMultiplier={1.3} style={styles.newText}>Nouveau</Text></View>
            )}
            {ep && seenInAnime && <Chip kind="anime" label={`Vu en anime · Ép. ${ep.number}`} />}
          </View>
          {p && !p.done ? (
            <>
              <Txt v="footnote" color={C.accentText} tabular style={{ ...F.semibold }}>En cours · {Math.round(p.ratio * 100)} %</Txt>
              <Progress value={p.ratio} />
            </>
          ) : (
            <Txt v="footnote" tabular>
              {p?.done ? 'Lu' : c.releasedDaysAgo < 0 ? (c.title || 'Chapitre') : c.releasedDaysAgo === 0 ? 'Aujourd’hui' : `il y a ${c.releasedDaysAgo} j`}
              {ep && !seenInAnime ? ` · adapté dans l’ép. ${ep.number}` : ''}
            </Txt>
          )}
        </View>
        {(canDownload || d) && <DownloadBadge entry={d} label={downloadLabel(d, blocked)} onPress={() => onBadge(c, d)} />}
      </Press>
    );
  };

  const headers = series.id.startsWith('px') ? coverHeaders : undefined;
  const started = !!(inProgress || lastRead);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Animated.FlatList
        style={{ flex: 1 }}
        data={list}
        keyExtractor={(c) => c.id}
        renderItem={renderRow}
        extraData={downloads}
        initialNumToRender={12}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + S.xxl, gap: 6 }}
        ListHeaderComponent={
          <View style={{ gap: S.lg, paddingBottom: S.sm }}>
            <DetailBackdrop series={series} headers={headers} scrollY={scrollY}>
              <Txt v="display" numberOfLines={3} style={styles.title}>{series.title}</Txt>
              <MetaLine
                items={[
                  <View key="st" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: series.status === 'ongoing' ? C.success : C.text2 }} />
                    <Txt v="small" color={C.body} style={F.medium}>{series.status === 'ongoing' ? 'En cours' : 'Terminé'}</Txt>
                  </View>,
                  `${all.length} chapitres`,
                  series.author,
                ]}
              />
              <Txt v="small" color={C.text2} numberOfLines={1}>{['Manhwa', ...series.genres].join(' · ')}</Txt>
            </DetailBackdrop>

            <View style={{ paddingHorizontal: S.lg, gap: S.lg }}>
              <Button
                large
                icon="book"
                label={!resume ? 'Aucun chapitre' : started ? `Continuer · Ch. ${resume.number}` : `Lire · Ch. ${resume.number}`}
                disabled={!resume}
                onPress={() => resume && router.push(`/read/${resume.id}`)}
              />
              <View style={styles.tiles}>
                <ActionTile icon={inList ? 'checkmark' : 'add'} label="Ma liste" active={inList} onPress={() => toggleMyList(series.id)}
                  accessibilityLabel={inList ? 'Retirer de ma liste' : 'Ajouter à ma liste'} />
                <ListsButton seriesId={series.id} tile />
                {canDownload && (
                  <ActionTile icon="arrow-down-circle-outline" label={dlDone.length ? `${dlDone.length} hors ligne` : 'Télécharger'} onPress={downloadMenu}
                    active={dlDone.length > 0} accessibilityLabel="Télécharger des chapitres" />
                )}
              </View>
              <SourcePanel series={series} />
              <Synopsis text={series.synopsis} />
              {series.anime && <BridgeToAnime series={series} />}
              <View style={{ gap: S.sm }}>
                <DetailTabs tabs={[{ label: `${all.length} chapitres`, active: true }]} />
                <View style={styles.listHead}>
                  <Txt v="footnote" tabular>
                    {dlDone.length > 0 ? `${dlDone.length} hors ligne · ${formatBytes(dlBytes)}` : started ? `Lu jusqu’au ch. ${lastRead || resume?.number}` : 'Aucun chapitre lu'}
                  </Txt>
                  <Pressable onPress={() => setNewestFirst((v) => !v)} hitSlop={10} accessibilityRole="button"
                    style={({ pressed }) => [styles.sort, pressed && { opacity: 0.6 }]}>
                    <Ionicons name="swap-vertical" size={14} color={C.text2} />
                    <Txt v="footnote" style={F.semibold}>{newestFirst ? 'Plus récents' : 'Plus anciens'}</Txt>
                  </Pressable>
                </View>
              </View>
            </View>
          </View>
        }
      />
      <DetailNav title={series.title} scrollY={scrollY} />
    </View>
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
  title: { fontSize: 36, lineHeight: 40, letterSpacing: -1.1, ...F.black, textShadowColor: 'rgba(0,0,0,0.4)', textShadowRadius: 16 },
  tiles: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 2 },
  listHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 32 },
  sort: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32, paddingHorizontal: 10, borderRadius: R.pill, backgroundColor: C.surface },
  badge: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  num: {
    width: 48, height: 48, borderRadius: R.control, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, boxShadow: '0px 1px 0px rgba(255,255,255,0.05) inset',
  },
  numMuted: { backgroundColor: 'transparent', borderColor: 'transparent', boxShadow: undefined },
  numNext: { backgroundColor: C.accentSoft, borderColor: C.accentLine },
  numText: { color: C.text, ...F.heavy, ...TABULAR },
  ring: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: C.accentLine, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingVertical: 6 },
  new: { paddingVertical: 2, paddingHorizontal: 6, borderRadius: 5, backgroundColor: C.accent },
  newText: { color: C.onAccent, fontSize: 10, ...F.bold },
});
