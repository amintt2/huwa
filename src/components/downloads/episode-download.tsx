// Episode download controls: the round status button of an episode row, and the download sheet
// (this episode / the next N / the season, quality, Wi-Fi only, pause / resume / delete).
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import type { AddonStream } from '@/addons/protocol';
import type { Episode, Series } from '@/data/catalog';
import {
  downloadsSupported,
  enqueueEpisodes,
  formatBytes,
  hlsAvailable,
  pauseDownload,
  removeDownload,
  resumeDownload,
  useDlSettings,
  useDownloadItem,
  useDownloadItems,
  type DlQuality,
  type DownloadItem,
} from '@/downloads';
import type { Pick } from '@/downloads/pick';
import { C, F, R, S } from '@/theme/tokens';

import { Sheet } from '../sheet';
import { Button, Progress, Txt, type IconName } from '../ui';

const QUALITY_LABEL: Record<string, string> = { auto: 'Auto', 1080: '1080p', 720: '720p', 480: '480p' };
const NEXT_COUNTS = [3, 5, 10];

export function statusLine(i: DownloadItem): string {
  switch (i.status) {
    case 'queued':
      return i.attempts ? `Nouvel essai bientôt · ${i.error ?? ''}` : 'En attente';
    case 'waiting-network':
      return 'En attente du Wi-Fi';
    case 'resolving':
      return 'Recherche de la source…';
    case 'downloading':
      if (i.kind === 'hls') return `Téléchargement… ${Math.round((i.bytes / 1000) * 100)} %`;
      return i.total ? `${formatBytes(i.bytes)} / ${formatBytes(i.total)}` : 'Téléchargement…';
    case 'paused':
      return 'En pause';
    case 'failed':
      return i.error ?? 'Échec';
    case 'done': {
      const c = i.compress;
      const extra =
        c?.state === 'running' ? ` · compression ${Math.round((c.progress ?? 0) * 100)} %`
        : c?.state === 'pending' ? ' · compression en attente'
        : c?.state === 'done' ? ` · compressé (${c.reason ?? ''})`
        : '';
      const q = i.source?.quality ? ` · ${i.source.quality}p` : '';
      return `${formatBytes(i.bytes)}${q}${extra}`;
    }
  }
}

export const progressOf = (i: DownloadItem) => (i.total > 0 ? i.bytes / i.total : 0);

/** Round status button for an episode row. Tap = download (or open the sheet when started). */
export function EpisodeDownloadButton({ episodeId, onPress, onLongPress }: { episodeId: string; onPress: () => void; onLongPress?: () => void }) {
  const i = useDownloadItem(episodeId);
  if (!downloadsSupported) return null;
  const busy = i && (i.status === 'downloading' || i.status === 'resolving');
  const icon: IconName =
    !i ? 'arrow-down-circle-outline'
    : i.status === 'done' ? 'checkmark-circle'
    : i.status === 'failed' ? 'alert-circle-outline'
    : i.status === 'paused' ? 'pause-circle-outline'
    : i.status === 'queued' || i.status === 'waiting-network' ? 'time-outline'
    : 'arrow-down';
  const color = !i ? C.text2 : i.status === 'done' ? C.accentText : i.status === 'failed' ? '#FF8A8A' : C.accentText;
  const label = !i ? 'Télécharger' : `Téléchargement : ${statusLine(i)}`;
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} hitSlop={8} accessibilityRole="button" accessibilityLabel={label} style={styles.btn}>
      {busy && i.status === 'downloading' && i.total > 0 ? (
        <View style={styles.pct}>
          <Txt v="caption" color={C.accentText} style={{ fontSize: 10 }}>{Math.round(progressOf(i) * 100)}</Txt>
        </View>
      ) : (
        <Ionicons name={icon} size={24} color={color} />
      )}
    </Pressable>
  );
}

export type PlayingSource = { stream: AddonStream; url?: string; via?: string; pick: Pick | null; reason?: string };

/** Download sheet for one episode (and the following ones). */
export function DownloadSheet({
  series, episode, visible, onClose, playing, subtitles,
}: {
  series: Series;
  episode: Episode;
  visible: boolean;
  onClose: () => void;
  /** Watch screen: the source playing now. */
  playing?: PlayingSource | null;
  /** Watch screen: subtitle files to save with the episode. */
  subtitles?: { url: string; lang: string; label?: string }[];
}) {
  const settings = useDlSettings();
  const items = useDownloadItems();
  const item = items[episode.id];
  const [quality, setQuality] = useState<DlQuality>(settings.quality);
  const [wifiOnly, setWifiOnly] = useState(settings.wifiOnly);
  const [count, setCount] = useState(3);
  const [done, setDone] = useState<string | null>(null);
  const eps = series.anime?.episodes ?? [];
  const remaining = eps.filter((e) => e.number >= episode.number).length;
  const seasonLeft = eps.filter((e) => !items[e.id] || items[e.id].status === 'failed').length;
  const blocked = playing && !playing.pick ? playing.reason : null;
  const hlsWarn = playing?.pick?.kind === 'hls' && !hlsAvailable();

  const go = (mode: 'one' | 'next' | 'season') => {
    const n = enqueueEpisodes(series, episode, mode, {
      quality, wifiOnly, count,
      playing: playing ? { stream: playing.stream, url: playing.url, via: playing.via, pick: playing.pick } : undefined,
      subtitles,
    });
    setDone(n ? `${n} épisode${n > 1 ? 's' : ''} ajouté${n > 1 ? 's' : ''} à la file.` : 'Déjà téléchargé ou en file.');
    setTimeout(() => {
      setDone(null);
      onClose();
    }, 900);
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      detents="fit"
      title={episode.title ? `Ép. ${episode.number} — ${episode.title}` : `Épisode ${episode.number}`}
      subtitle={series.title}>
      {item && item.status !== 'failed' ? (
        <View style={{ gap: S.md }}>
          <View style={styles.card}>
            <Txt v="label">{item.status === 'done' ? 'Disponible hors ligne' : 'Téléchargement'}</Txt>
            <Txt v="small">{statusLine(item)}</Txt>
            {item.status === 'downloading' && <Progress value={progressOf(item)} height={4} />}
            {item.compress?.reason && item.compress.state !== 'done' && <Txt v="small">{item.compress.reason}</Txt>}
          </View>
          <View style={{ flexDirection: 'row', gap: S.sm }}>
            {(item.status === 'downloading' || item.status === 'resolving' || item.status === 'queued' || item.status === 'waiting-network') && (
              <Button style={{ flex: 1 }} variant="ghost" icon="pause" label="Pause" onPress={() => void pauseDownload(item.id)} />
            )}
            {item.status === 'paused' && <Button style={{ flex: 1 }} variant="soft" icon="play" label="Reprendre" onPress={() => resumeDownload(item.id)} />}
            <Button
              style={{ flex: 1 }}
              variant="ghost"
              icon="trash-outline"
              label={item.status === 'done' ? 'Supprimer' : 'Annuler'}
              onPress={() => {
                removeDownload(item.id);
                onClose();
              }}
            />
          </View>
        </View>
      ) : (
        <>
          {item?.status === 'failed' && (
            <View style={[styles.card, { borderColor: 'rgba(255,107,107,0.35)' }]}>
              <Txt v="label">Le téléchargement a échoué</Txt>
              <Txt v="small">{item.error}</Txt>
            </View>
          )}
          {blocked && (
            <View style={styles.card}>
              <Txt v="label">Source actuelle non téléchargeable</Txt>
              <Txt v="small">{blocked} Une autre source de la liste sera cherchée.</Txt>
            </View>
          )}
          <View style={{ gap: S.sm }}>
            <Txt v="caption" color={C.text2}>Qualité</Txt>
            <View style={styles.row}>
              {(['auto', 1080, 720, 480] as DlQuality[]).map((q) => (
                <Choice key={q} label={QUALITY_LABEL[q]} on={quality === q} onPress={() => setQuality(q)} />
              ))}
            </View>
            <Txt v="small">{quality === 'auto' ? 'La source que le lecteur choisit (ou celle que tu as choisie).' : 'La source la plus proche de cette qualité.'}</Txt>
            {hlsWarn && <Txt v="small" color="#F5B544">Source HLS : le téléchargement hors ligne demande un iPhone et la dernière version de l’app.</Txt>}
          </View>
          <View style={[styles.row, { justifyContent: 'space-between', alignItems: 'center' }]}>
            <View style={{ flex: 1 }}>
              <Txt v="label">Wi-Fi uniquement</Txt>
              <Txt v="small">Attend le Wi-Fi avant de télécharger.</Txt>
            </View>
            <Switch value={wifiOnly} onValueChange={setWifiOnly} trackColor={{ true: C.accent }} />
          </View>
          {done ? (
            <Txt v="label" color={C.accentText} style={{ textAlign: 'center', paddingVertical: S.md }}>{done}</Txt>
          ) : (
            <View style={{ gap: S.sm }}>
              <Button icon="arrow-down" label={item?.status === 'failed' ? 'Réessayer' : 'Télécharger cet épisode'} onPress={() => go('one')} />
              {remaining > 1 && (
                <View style={{ flexDirection: 'row', gap: S.sm, alignItems: 'center' }}>
                  <Button style={{ flex: 1 }} variant="soft" label={`Les ${Math.min(count, remaining)} suivants`} onPress={() => go('next')} />
                  {NEXT_COUNTS.filter((n) => n <= Math.max(remaining, 3)).map((n) => (
                    <Choice key={n} label={String(n)} on={count === n} onPress={() => setCount(n)} />
                  ))}
                </View>
              )}
              {eps.length > 1 && <Button variant="ghost" label={`Toute la saison (${seasonLeft} ép.)`} onPress={() => go('season')} />}
            </View>
          )}
        </>
      )}
    </Sheet>
  );
}

function Choice({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }} style={[styles.choice, on && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
      <Txt v="small" color={on ? C.accentText : C.body} style={F.semibold}>{label}</Txt>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  pct: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: C.accentText, alignItems: 'center', justifyContent: 'center' },
  card: { padding: S.md, gap: 6, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm },
  choice: {
    minHeight: 36, minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: S.md, borderRadius: R.control, borderCurve: 'continuous',
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border,
  },
});
