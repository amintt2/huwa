// "Téléchargements" screen, episode part: queue in progress, series → episodes, storage, settings
// (quality, Wi-Fi, quota, auto-delete, next episode on Wi-Fi, compression intelligente).
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Switch, View } from 'react-native';

import { getSeries } from '@/data/catalog';
import {
  compressionAvailable,
  compressionBlocked,
  DL_QUOTAS,
  downloadsSupported,
  formatBytes,
  pauseDownload,
  removeAll,
  removeDownload,
  removeSeries,
  resumeDownload,
  setDlSettings,
  useDlSettings,
  useDownloadItems,
  type DlQuality,
  type DownloadItem,
} from '@/downloads';
import { COMPRESS_LABEL, estimateSaving, type CompressMode } from '@/downloads/compress';
import { groupBySeries } from '@/downloads/queue';
import { C, F, R, S, SHADOW } from '@/theme/tokens';

import { EmptyState } from '../feedback';
import { Segmented as SegmentedControl } from '../states';
import { Cover, IconButton, Progress, Txt } from '../ui';
import { progressOf, statusLine } from './episode-download';

const QUALITY_LABEL: Record<string, string> = { auto: 'Auto', 1080: '1080p', 720: '720p', 480: '480p' };

export function EpisodeDownloads() {
  const items = useDownloadItems();
  const settings = useDlSettings();
  const groups = useMemo(() => groupBySeries(items), [items]);
  const list = Object.values(items);
  const active = list.filter((i) => i.status !== 'done').sort((a, b) => a.createdAt - b.createdAt);
  const used = list.reduce((n, i) => n + (i.status === 'done' ? i.bytes : i.bytes || 0), 0);
  const [open, setOpen] = useState<string | null>(null);

  if (!downloadsSupported) return null;

  const clearAll = () =>
    Alert.alert('Supprimer tous les épisodes ?', 'Les épisodes téléchargés et la file seront effacés de l’appareil.', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Tout supprimer', style: 'destructive', onPress: removeAll },
    ]);

  return (
    <View style={{ gap: S.xl }}>
      <View style={{ gap: S.sm }}>
        <View style={styles.between}>
          <Txt v="section">Épisodes</Txt>
          <Txt v="small">{formatBytes(used)} / {formatBytes(settings.quotaBytes)}</Txt>
        </View>
        <Progress value={settings.quotaBytes ? used / settings.quotaBytes : 0} height={6} />
      </View>

      {active.length > 0 && (
        <View style={{ gap: S.sm }}>
          <Txt v="label">File d’attente ({active.length})</Txt>
          {active.map((i) => (
            <QueueRow key={i.id} i={i} />
          ))}
        </View>
      )}

      {groups.filter((g) => g.items.some((i) => i.status === 'done')).length === 0 && active.length === 0 ? (
        <View style={[styles.card, { padding: 0 }]}>
          <EmptyState
            compact
            icon="arrow-down-circle-outline"
            title="Aucun épisode téléchargé"
            text="Touche l’icône de téléchargement à côté d’un épisode, ou garde le doigt dessus pour télécharger les suivants ou la saison."
          />
        </View>
      ) : (
        <View style={{ gap: S.sm }}>
          {groups
            .map((g) => ({ ...g, done: g.items.filter((i) => i.status === 'done') }))
            .filter((g) => g.done.length > 0)
            .map((g) => {
              const series = getSeries(g.seriesId);
              const expanded = open === g.seriesId;
              const bytes = g.done.reduce((n, i) => n + i.bytes, 0);
              return (
                <View key={g.seriesId} style={styles.card}>
                  <Pressable onPress={() => setOpen(expanded ? null : g.seriesId)} style={styles.between} accessibilityRole="button" accessibilityState={{ expanded }}>
                    {series ? (
                      <Cover palette={series.palette} image={series.image ?? g.image} width={44} height={62} radius={8} />
                    ) : (
                      <View style={{ width: 44, height: 62, borderRadius: 8, backgroundColor: C.elevated }} />
                    )}
                    <View style={{ flex: 1, gap: 2 }}>
                      <Txt v="label" numberOfLines={1}>{g.title}</Txt>
                      <Txt v="small">{g.done.length} épisode{g.done.length > 1 ? 's' : ''} · {formatBytes(bytes)}</Txt>
                    </View>
                    <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={C.text2} />
                  </Pressable>
                  {expanded && (
                    <View style={{ gap: 2 }}>
                      {g.done.map((i) => (
                        <View key={i.id} style={[styles.between, { paddingVertical: 6 }]}>
                          <Pressable style={{ flex: 1, gap: 2 }} onPress={() => router.push(`/watch/${i.id}`)} accessibilityRole="button" accessibilityLabel={`Lire ${i.title}`}>
                            <Txt v="label" numberOfLines={1} style={{ fontSize: 14 }}>{i.title}</Txt>
                            <Txt v="small" numberOfLines={2}>{statusLine(i)}</Txt>
                          </Pressable>
                          <IconButton tone="solid" icon="play" label="Lire" size={34} onPress={() => router.push(`/watch/${i.id}`)} />
                          <IconButton tone="solid" icon="trash-outline" label="Supprimer" size={34} onPress={() => removeDownload(i.id)} />
                        </View>
                      ))}
                      <Pressable
                        onPress={() =>
                          Alert.alert(`Supprimer ${g.title} ?`, 'Tous ses épisodes téléchargés seront effacés.', [
                            { text: 'Annuler', style: 'cancel' },
                            { text: 'Supprimer', style: 'destructive', onPress: () => removeSeries(g.seriesId) },
                          ])
                        }
                        style={{ paddingVertical: S.sm }}
                        accessibilityRole="button">
                        <Txt v="small" color="#FF8A8A" style={F.semibold}>Supprimer la série</Txt>
                      </Pressable>
                    </View>
                  )}
                </View>
              );
            })}
          {list.length > 0 && (
            <Pressable onPress={clearAll} style={{ alignSelf: 'flex-start', paddingVertical: S.sm }} accessibilityRole="button">
              <Txt v="small" color="#FF8A8A" style={F.semibold}>Tout supprimer</Txt>
            </Pressable>
          )}
        </View>
      )}

      <DownloadSettings items={list} />
    </View>
  );
}

function QueueRow({ i }: { i: DownloadItem }) {
  const busy = i.status === 'downloading' || i.status === 'resolving' || i.status === 'queued' || i.status === 'waiting-network';
  return (
    <View style={[styles.card, { gap: S.sm }]}>
      <View style={styles.between}>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="small" numberOfLines={1}>{i.seriesTitle}</Txt>
          <Txt v="label" numberOfLines={1} style={{ fontSize: 14 }}>{i.title}</Txt>
          <Txt v="small" numberOfLines={2} color={i.status === 'failed' ? '#FF8A8A' : C.text2}>{statusLine(i)}</Txt>
        </View>
        {busy && <IconButton tone="solid" icon="pause" label="Mettre en pause" size={34} onPress={() => void pauseDownload(i.id)} />}
        {i.status === 'paused' && <IconButton tone="solid" icon="play" label="Reprendre" size={34} onPress={() => resumeDownload(i.id)} />}
        {i.status === 'failed' && <IconButton tone="solid" icon="refresh" label="Réessayer" size={34} onPress={() => resumeDownload(i.id)} />}
        <IconButton tone="solid" icon="close" label="Annuler" size={34} onPress={() => removeDownload(i.id)} />
      </View>
      {i.status === 'downloading' && <Progress value={progressOf(i)} />}
    </View>
  );
}

/** The shared segmented control, for string or number values. */
function Segmented<T extends string | number>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: (v: T) => string }) {
  return (
    <SegmentedControl
      accessibilityLabel={label(value)}
      value={String(value)}
      onChange={(v) => {
        const o = options.find((x) => String(x.value) === v);
        if (o) onChange(o.value);
      }}
      options={options.map((o) => ({ value: String(o.value), label: o.label }))}
    />
  );
}

function SwitchRow({ title, sub, value, onChange }: { title: string; sub: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.between}>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="label">{title}</Txt>
        <Txt v="small">{sub}</Txt>
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: C.accent }} />
    </View>
  );
}

function DownloadSettings({ items }: { items: DownloadItem[] }) {
  const s = useDlSettings();
  const done = items.filter((i) => i.status === 'done');
  const asInput = done.map((i) => ({
    container: i.file?.split('.').pop() ?? '',
    codec: i.codec,
    width: i.width,
    height: i.height,
    durationSec: i.durationSec ?? i.durationMin * 60,
    sizeBytes: i.bytes,
    compressed: i.compress?.state === 'done',
  }));
  const saved = done.reduce((n, i) => n + (i.compress?.state === 'done' && i.compress.originalBytes ? i.compress.originalBytes - i.bytes : 0), 0);
  const native = compressionAvailable();
  const blocked = native && s.compression !== 'off' ? compressionBlocked() : null;
  const unreadable = done.filter((i) => i.compress?.state === 'unsupported').length;

  return (
    <View style={{ gap: S.lg }}>
      <Txt v="section">Réglages</Txt>
      <View style={[styles.card, { gap: S.lg }]}>
        <View style={{ gap: S.sm }}>
          <Txt v="label">Qualité par défaut</Txt>
          <Segmented<DlQuality>
            options={(['auto', 1080, 720, 480] as DlQuality[]).map((v) => ({ value: v, label: QUALITY_LABEL[v] }))}
            value={s.quality}
            onChange={(quality) => setDlSettings({ quality })}
            label={(v) => `Qualité ${QUALITY_LABEL[v]}`}
          />
        </View>
        <SwitchRow title="Wi-Fi uniquement" sub="Les téléchargements attendent le Wi-Fi." value={s.wifiOnly} onChange={(wifiOnly) => setDlSettings({ wifiOnly })} />
        <View style={{ gap: S.sm }}>
          <Txt v="label">Espace maximum</Txt>
          <Segmented<number>
            options={DL_QUOTAS.map((q) => ({ value: q, label: formatBytes(q) }))}
            value={s.quotaBytes}
            onChange={(quotaBytes) => setDlSettings({ quotaBytes })}
            label={(v) => `Quota ${formatBytes(v)}`}
          />
          <Txt v="small">Au-delà, les épisodes déjà vus sont supprimés en premier ; jamais un épisode pas encore vu.</Txt>
        </View>
        <SwitchRow
          title="Supprimer les épisodes vus"
          sub="Un épisode regardé jusqu’au bout est effacé de l’appareil."
          value={s.autoDeleteWatched}
          onChange={(autoDeleteWatched) => setDlSettings({ autoDeleteWatched })}
        />
        <SwitchRow
          title="Épisode suivant automatiquement"
          sub="Sur Wi-Fi, télécharge l’épisode suivant des séries que tu regardes."
          value={s.autoNext}
          onChange={(autoNext) => setDlSettings({ autoNext })}
        />
      </View>

      <View style={[styles.card, { gap: S.md }]}>
        <View style={{ gap: 2 }}>
          <Txt v="label">Compression intelligente</Txt>
          <Txt v="small">
            Réencode les épisodes en HEVC avec l’encodeur matériel de l’iPhone pour prendre moins de place, à qualité quasi identique.
            Uniquement sur secteur ou au-dessus de 50 % de batterie, jamais en mode économie d’énergie.
          </Txt>
        </View>
        <Segmented<CompressMode>
          options={(['off', 'balanced', 'max'] as CompressMode[]).map((v) => ({ value: v, label: COMPRESS_LABEL[v] }))}
          value={s.compression}
          onChange={(compression) => setDlSettings({ compression })}
          label={(v) => `Compression ${COMPRESS_LABEL[v]}`}
        />
        {(['balanced', 'max'] as const).map((m) => (
          <Txt key={m} v="small" color={s.compression === m ? C.accentText : C.text2}>
            {COMPRESS_LABEL[m]} : ≈ {formatBytes(estimateSaving(asInput, m))} gagnés sur tes épisodes actuels
            {m === 'balanced' ? ' (≈ 2,2 Mb/s en 1080p)' : ' (≈ 1,5 Mb/s en 1080p)'}
          </Txt>
        ))}
        {saved > 0 && <Txt v="small" color={C.success}>Déjà gagné : {formatBytes(saved)}</Txt>}
        {!native && <Txt v="small" color={C.star}>Encodeur absent de ce build (Android ou ancienne version) : les fichiers restent tels quels.</Txt>}
        {blocked && <Txt v="small" color={C.star}>{blocked}</Txt>}
        <Txt v="small">
          Les fichiers MKV et WebM ne sont pas lisibles par l’encodeur de l’iPhone : ils restent tels quels{unreadable ? ` (${unreadable} épisode${unreadable > 1 ? 's' : ''})` : ''}.
          Un fichier déjà léger (HEVC/AV1 à faible débit, ou gain estimé sous 25 %) n’est pas touché.
        </Txt>
      </View>
      <Txt v="small">Les téléchargements sont des copies personnelles des sources que tu as ajoutées, gardées sur cet appareil.</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: S.md, gap: S.md, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, boxShadow: SHADOW.inset },
  between: { flexDirection: 'row', alignItems: 'center', gap: S.md },
  seg: {
    paddingVertical: 8, paddingHorizontal: 14, borderRadius: R.control, borderCurve: 'continuous',
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border,
  },
});
