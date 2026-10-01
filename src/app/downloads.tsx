// « Téléchargements » : épisodes hors ligne (file, séries → épisodes, espace, réglages,
// compression intelligente), puis le cache du moteur torrent.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EpisodeDownloads } from '@/components/downloads/downloads-screen';
import { Button, IconButton, Press, Progress, Txt } from '@/components/ui';
import { C, F, R, S } from '@/theme/tokens';

import {
  clearCache,
  ensureEngine,
  ensureLegalAccepted,
  formatBytes,
  isAvailable,
  nativeVersion,
  pause,
  QUOTA_CHOICES,
  resume,
  setQuota,
  setTorrentSettings,
  stats,
  stop,
  useTorrentList,
  useTorrentSettings,
  type EngineStats,
  type TorrentStatus,
} from '@/torrent';

export default function Downloads() {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      contentContainerStyle={{ paddingTop: insets.top + S.sm, paddingHorizontal: S.lg, gap: S.xl, paddingBottom: S.xxl }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
        <Txt v="display" style={{ fontSize: 28 }}>Téléchargements</Txt>
      </View>
      <EpisodeDownloads />
      <Press onPress={() => router.push('/offline')} style={styles.card} accessibilityRole="button">
        <View style={styles.rowBetween}>
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="label">Chapitres manhwa hors ligne</Txt>
            <Txt v="small">Les chapitres téléchargés depuis le lecteur.</Txt>
          </View>
          <Txt v="label" color={C.text2}>›</Txt>
        </View>
      </Press>
      <TorrentCacheSection />
    </ScrollView>
  );
}

const STATE_LABEL: Record<TorrentStatus['state'], string> = {
  resolving: 'Recherche des métadonnées…',
  initializing: 'Vérification…',
  live: 'En cours',
  paused: 'En pause',
  finished: 'Terminé',
  error: 'Erreur',
};

/** Torrent cache of the on-device engine (PLAN 7c): space used, settings, torrents. */
function TorrentCacheSection() {
  const available = isAvailable();
  const settings = useTorrentSettings();
  const torrents = useTorrentList();
  const [engine, setEngine] = useState<EngineStats | undefined>();
  const [engineError, setEngineError] = useState('');

  // Start the engine when the user enabled it, and refresh disk usage every 5 s.
  useEffect(() => {
    if (!available || !settings.enabled) return;
    let cancelled = false;
    const refresh = () =>
      ensureEngine()
        .then(stats)
        .then((s) => !cancelled && setEngine(s))
        .catch((e) => !cancelled && setEngineError(e instanceof Error ? e.message : String(e)));
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [available, settings.enabled, torrents.length]);

  const used = engine?.cacheUsedBytes ?? torrents.reduce((n, t) => n + t.sizeOnDisk, 0);

  const toggleEnabled = async (on: boolean) => {
    if (on && !(await ensureLegalAccepted())) return;
    setTorrentSettings({ enabled: on });
  };

  const removeAll = () =>
    Alert.alert('Vider le cache ?', 'Les torrents non utilisés en ce moment et leurs fichiers seront supprimés.', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Vider', style: 'destructive', onPress: () => clearCache().catch(() => {}) },
    ]);

  return (
    <View style={{ gap: S.xl }}>
      <Txt v="section">Cache torrent</Txt>
      {!available ? (
        <View style={styles.card}>
          <Txt v="label">Moteur torrent absent de ce build</Txt>
          <Txt v="small">
            Compile la bibliothèque native (scripts/build-torrent.sh) puis reconstruis l’app avec HUWA_TORRENT=1.
            En attendant, les sources torrent passent par un service débrid si tu en as configuré un.
          </Txt>
        </View>
      ) : (
        <>
          <View style={styles.card}>
            <View style={styles.rowBetween}>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt v="label">Moteur torrent</Txt>
                <Txt v="small">Désactivé par défaut. Lecture en pair-à-pair, partage (seeding) coupé.</Txt>
              </View>
              <Switch value={settings.enabled} onValueChange={toggleEnabled} trackColor={{ true: C.accent }} />
            </View>
            <View style={styles.rowBetween}>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt v="label">Wi-Fi seulement</Txt>
                <Txt v="small">Ne jamais streamer en torrent sur le réseau mobile.</Txt>
              </View>
              <Switch
                value={settings.wifiOnly}
                onValueChange={(v) => {
                  setTorrentSettings({ wifiOnly: v });
                }}
                trackColor={{ true: C.accent }}
              />
            </View>
          </View>

          <View style={{ gap: S.sm }}>
            <View style={styles.rowBetween}>
              <Txt v="label">Espace du cache</Txt>
              <Txt v="small">{formatBytes(used)} / {formatBytes(settings.quotaBytes)}</Txt>
            </View>
            <Progress value={settings.quotaBytes ? used / settings.quotaBytes : 0} height={6} />
            <View style={{ flexDirection: 'row', gap: S.sm, flexWrap: 'wrap' }}>
              {QUOTA_CHOICES.map((q) => {
                const active = q === settings.quotaBytes;
                return (
                  <Press
                    key={q}
                    onPress={() => setQuota(q).catch(() => {})}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={[styles.quota, active && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
                    <Txt v="caption" color={active ? C.accentText : C.body}>{formatBytes(q)}</Txt>
                  </Press>
                );
              })}
            </View>
            <Txt v="small">Au-delà du quota, les torrents les moins récemment lus sont effacés automatiquement.</Txt>
            <Button small variant="soft" icon="trash-outline" label="Vider le cache" onPress={removeAll} />
          </View>

          <View style={{ gap: S.md }}>
            <Txt v="label">En cache ({torrents.length})</Txt>
            {!!engineError && <Txt v="small" color="#FF6B6B">{engineError}</Txt>}
            {torrents.length === 0 && (
              <Txt v="small">
                {settings.enabled
                  ? 'Aucun torrent. Lance une source torrent depuis un épisode.'
                  : 'Active le moteur pour lire les sources torrent des addons.'}
              </Txt>
            )}
            {torrents.map((t) => (
              <TorrentRow key={t.id} t={t} />
            ))}
          </View>

          <Txt v="small">
            Huwa ne fournit aucun contenu ni aucune source. Vérifie que tu as le droit de lire ce que tes addons proposent.
            Moteur : {nativeVersion()}.
          </Txt>
        </>
      )}
    </View>
  );
}

function TorrentRow({ t }: { t: TorrentStatus }) {
  const paused = t.state === 'paused';
  const busy = t.state === 'live' || t.state === 'initializing' || t.state === 'resolving';
  const fileName = t.selectedFile != null ? t.files[t.selectedFile]?.name : undefined;
  const meta = [
    STATE_LABEL[t.state],
    t.state === 'live' ? `${formatBytes(t.downloadBps)}/s · ${t.peersLive} pairs` : undefined,
    t.totalBytes ? `${formatBytes(t.progressBytes)} / ${formatBytes(t.totalBytes)}` : undefined,
    t.activeStreams > 0 ? 'lecture' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  const remove = () =>
    Alert.alert(`Supprimer ${t.name ?? t.infoHash.slice(0, 8)} ?`, 'Le fichier téléchargé sera effacé.', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Supprimer', style: 'destructive', onPress: () => stop(t.id).catch(() => {}) },
    ]);

  return (
    <View style={[styles.card, { gap: S.sm }]}>
      <View style={styles.rowBetween}>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="label" numberOfLines={1}>{t.name ?? t.infoHash}</Txt>
          {fileName && fileName !== t.name && <Txt v="small" numberOfLines={1}>{fileName}</Txt>}
          <Txt v="small" numberOfLines={2} color={t.state === 'error' ? '#FF6B6B' : C.text2}>
            {t.state === 'error' && t.error ? t.error : meta}
          </Txt>
        </View>
        {busy && <IconButton tone="solid" icon="pause" label="Mettre en pause" size={36} onPress={() => pause(t.id).catch(() => {})} />}
        {paused && <IconButton tone="solid" icon="play" label="Reprendre" size={36} onPress={() => resume(t.id).catch(() => {})} />}
        <IconButton tone="solid" icon="trash-outline" label="Supprimer" size={36} onPress={remove} />
      </View>
      <Progress value={t.progress} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: S.md, gap: S.md, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface },
  rowBetween: { flexDirection: 'row', alignItems: 'center', gap: S.md },
  quota: {
    paddingVertical: 8, paddingHorizontal: 14, borderRadius: R.control, borderCurve: 'continuous',
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border, ...F.semibold,
  },
});
