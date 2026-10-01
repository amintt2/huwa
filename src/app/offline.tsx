// Manhwa downloads: settings (Wi-Fi only, auto-download of the next chapters), the queue, and the
// chapters kept on the device grouped by series with their storage.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { bySeries } from '@/components/reader/download-queue';
import {
  downloadLabel,
  downloadsSupported,
  formatBytes,
  pauseAll,
  pauseDownload,
  removeAllDownloads,
  removeDownload,
  removeSeriesDownloads,
  resumeAll,
  resumeDownload,
  setDownloadPref,
  useDownloadQueue,
  useDownloads,
  type DownloadEntry,
  type QueueBlock,
  type SeriesDownloads,
} from '@/components/reader/downloads';
import { Cover, IconButton, Press, Progress, Txt } from '@/components/ui';
import { palette } from '@/data/anilist';
import { getChapter, getSeries } from '@/data/catalog';
import { C, F, R, S } from '@/theme/tokens';

function ChapterRow({ e, blocked }: { e: DownloadEntry; blocked: QueueBlock }) {
  const found = getChapter(e.chapterId);
  const busy = e.status === 'queued' || e.status === 'downloading';
  const status = e.status === 'done' ? `${e.total} pages · ${formatBytes(e.bytes)}` : e.status === 'error' ? `Échec${e.error ? ` · ${e.error}` : ''}` : downloadLabel(e, blocked);
  return (
    <Press onPress={() => found && router.push(`/read/${e.chapterId}`)} style={styles.chapter} accessibilityLabel={`Chapitre ${found?.chapter.number ?? ''}, ${status}`}>
      <View style={{ flex: 1, gap: 3 }}>
        <Txt v="label" style={{ fontSize: 14 }} numberOfLines={1}>{found ? `Chapitre ${found.chapter.number}` : e.chapterId}</Txt>
        <Txt v="small" style={{ fontSize: 12 }} color={e.status === 'error' ? '#FF8A8A' : C.text2} numberOfLines={1}>{status}</Txt>
        {e.status === 'downloading' && e.total > 0 && <Progress value={e.saved / e.total} color={C.accent} />}
      </View>
      {(busy || e.status === 'paused' || e.status === 'error') && (
        <IconButton
          icon={busy ? 'pause' : 'play'}
          label={busy ? 'Mettre en pause' : 'Reprendre'}
          size={34}
          tone="solid"
          onPress={() => (busy ? pauseDownload(e.chapterId) : resumeDownload(e.chapterId))}
        />
      )}
      <IconButton icon={e.status === 'done' ? 'trash-outline' : 'close'} label={e.status === 'done' ? 'Supprimer' : 'Annuler'} size={34} tone="solid" onPress={() => removeDownload(e.chapterId)} />
    </Press>
  );
}

function SeriesCard({ g, blocked }: { g: SeriesDownloads; blocked: QueueBlock }) {
  const [open, setOpen] = useState(false);
  const series = getSeries(g.seriesId);
  const sub = [
    `${g.done} chapitre${g.done > 1 ? 's' : ''}`,
    formatBytes(g.bytes),
    g.active ? `${g.active} en cours` : '',
    g.paused ? `${g.paused} en pause` : '',
    g.failed ? `${g.failed} en échec` : '',
  ].filter(Boolean);
  const progress = g.chapters.length ? g.done / g.chapters.length : 0;
  return (
    <View style={styles.card}>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.cardHead} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${series?.title ?? 'Série'}, ${sub.join(', ')}`}>
        <Cover palette={series?.palette ?? palette(null)} image={series?.image} width={48} height={66} radius={8} />
        <View style={{ flex: 1, gap: 4 }}>
          <Txt v="label" numberOfLines={1}>{series?.title ?? 'Série inconnue'}</Txt>
          <Txt v="small" style={{ fontSize: 12 }} numberOfLines={1}>{sub.join(' · ')}</Txt>
          {g.active + g.paused > 0 && <Progress value={progress} color={C.accent} />}
        </View>
        <IconButton
          icon="trash-outline"
          label="Supprimer la série"
          size={36}
          tone="solid"
          onPress={() =>
            Alert.alert('Supprimer les chapitres ?', `${series?.title ?? 'Cette série'} : ${formatBytes(g.bytes)} seront libérés.`, [
              { text: 'Annuler', style: 'cancel' },
              { text: 'Supprimer', style: 'destructive', onPress: () => removeSeriesDownloads(g.seriesId) },
            ])
          }
        />
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={C.text2} />
      </Pressable>
      {open && (
        <View style={{ gap: S.xs }}>
          {g.chapters.map((e) => (
            <ChapterRow key={e.chapterId} e={e} blocked={blocked} />
          ))}
        </View>
      )}
    </View>
  );
}

function Toggle({ label, sub, value, onChange }: { label: string; sub?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.toggle}>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="label" style={{ fontSize: 14 }}>{label}</Txt>
        {!!sub && <Txt v="small" style={{ fontSize: 12 }}>{sub}</Txt>}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: C.accent }} accessibilityLabel={label} />
    </View>
  );
}

export default function OfflineChapters() {
  const insets = useSafeAreaInsets();
  const all = useDownloads();
  const { prefs, blocked } = useDownloadQueue();
  const groups = bySeries(all);
  const bytes = groups.reduce((n, g) => n + g.bytes, 0);
  const done = groups.reduce((n, g) => n + g.done, 0);
  const active = groups.reduce((n, g) => n + g.active, 0);
  const paused = groups.reduce((n, g) => n + g.paused, 0);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
      <View style={styles.head}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
        <View style={{ flex: 1 }}>
          <Txt v="title">Téléchargements</Txt>
          <Txt v="small">
            {done} chapitre{done > 1 ? 's' : ''} hors-ligne · {formatBytes(bytes)}
          </Txt>
        </View>
        {groups.length > 0 && (
          <IconButton
            icon="trash-outline"
            label="Tout supprimer"
            onPress={() =>
              Alert.alert('Tout supprimer ?', 'Les chapitres téléchargés seront effacés de l’appareil.', [
                { text: 'Annuler', style: 'cancel' },
                { text: 'Supprimer', style: 'destructive', onPress: removeAllDownloads },
              ])
            }
          />
        )}
      </View>
      <FlatList
        data={groups}
        keyExtractor={(g) => g.seriesId}
        renderItem={({ item }) => <SeriesCard g={item} blocked={blocked} />}
        contentContainerStyle={{ padding: S.lg, gap: S.md, paddingBottom: insets.bottom + S.xl }}
        ListHeaderComponent={
          <View style={{ gap: S.md, paddingBottom: S.sm }}>
            {downloadsSupported && (
              <View style={styles.card}>
                <Toggle label="Wi-Fi uniquement" sub="Les téléchargements attendent une connexion Wi-Fi." value={prefs.wifiOnly} onChange={(v) => setDownloadPref('wifiOnly', v)} />
                <View style={styles.sep} />
                <Toggle
                  label={`Télécharger automatiquement les ${prefs.autoCount} chapitres suivants sur Wi-Fi`}
                  sub="Quand tu ouvres un chapitre, les suivants sont gardés pour la lecture hors-ligne."
                  value={prefs.autoNext}
                  onChange={(v) => setDownloadPref('autoNext', v)}
                />
                <Txt v="small" style={{ fontSize: 11 }}>Les pages sont gardées dans leur format d’origine (JPEG, WebP…), sans perte.</Txt>
              </View>
            )}
            {(active > 0 || paused > 0) && (
              <View style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: S.md }]}>
                <Ionicons name={blocked ? 'wifi-outline' : active ? 'cloud-download-outline' : 'pause-circle-outline'} size={20} color={C.accentText} />
                <Txt v="small" style={{ flex: 1, ...F.semibold }} color={C.text}>
                  {blocked === 'wifi-only' ? `${active} en attente du Wi-Fi` : blocked === 'offline' ? `${active} en attente du réseau` : active ? `${active} en cours` : ''}
                  {active && paused ? ' · ' : ''}
                  {paused ? `${paused} en pause` : ''}
                </Txt>
                <Pressable onPress={active ? pauseAll : resumeAll} hitSlop={8} accessibilityRole="button">
                  <Txt v="small" color={C.accentText} style={F.semibold}>{active ? 'Tout mettre en pause' : 'Tout reprendre'}</Txt>
                </Pressable>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="cloud-download-outline" size={40} color={C.text2} />
            <Txt v="label">Aucun chapitre hors-ligne</Txt>
            <Txt v="body" style={{ textAlign: 'center' }}>
              {downloadsSupported
                ? 'Sur la page d’un manhwa, touche l’icône de téléchargement d’un chapitre, ou télécharge les suivants d’un coup.'
                : 'Le téléchargement n’est pas disponible sur le web.'}
            </Txt>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingVertical: S.md },
  card: { gap: S.md, padding: S.md, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: S.md },
  chapter: { flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingVertical: S.sm, paddingHorizontal: S.sm, borderRadius: R.control, backgroundColor: C.elevated },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: S.md },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: C.border },
  empty: { alignItems: 'center', gap: S.sm, paddingTop: 60, paddingHorizontal: S.xl },
});
