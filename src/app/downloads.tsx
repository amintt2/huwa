import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Alert, FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  cancelDownload,
  downloadChapter,
  downloadsSupported,
  formatBytes,
  removeAllDownloads,
  removeDownload,
  useDownloads,
  type DownloadEntry,
} from '@/components/reader/downloads';
import { Cover, IconButton, Press, Progress, Txt } from '@/components/ui';
import { chapterLabel, getChapter } from '@/data/catalog';
import { C, R, S } from '@/theme/tokens';

function Row({ e }: { e: DownloadEntry }) {
  const found = getChapter(e.chapterId);
  const busy = e.status === 'queued' || e.status === 'downloading';
  const status =
    e.status === 'done'
      ? `${e.total} pages · ${formatBytes(e.bytes)}`
      : e.status === 'error'
        ? `Échec${e.error ? ` · ${e.error}` : ''}`
        : e.total
          ? `Téléchargement… ${e.saved}/${e.total}`
          : 'En attente…';
  return (
    <Press
      onPress={() => found && router.push(`/read/${e.chapterId}`)}
      style={styles.row}
      accessibilityLabel={`${found ? chapterLabel(found.chapter) : e.chapterId}, ${status}`}>
      {found ? (
        <Cover palette={found.series.palette} image={found.series.image} width={48} height={64} radius={8} />
      ) : (
        <View style={{ width: 48, height: 64, borderRadius: 8, backgroundColor: C.elevated }} />
      )}
      <View style={{ flex: 1, gap: 4 }}>
        <Txt v="small" numberOfLines={1}>{found?.series.title ?? 'Série inconnue'}</Txt>
        <Txt v="label" numberOfLines={1}>{found ? chapterLabel(found.chapter) : e.chapterId}</Txt>
        <Txt v="small" style={{ fontSize: 12 }} color={e.status === 'error' ? '#FF8A8A' : C.text2} numberOfLines={1}>{status}</Txt>
        {busy && e.total > 0 && <Progress value={e.saved / e.total} color={C.accent} />}
      </View>
      {e.status === 'error' && (
        <IconButton icon="refresh" label="Réessayer" size={38} tone="solid" onPress={() => downloadChapter(e.chapterId, e.seriesId)} />
      )}
      <IconButton
        icon={busy ? 'close' : 'trash-outline'}
        label={busy ? 'Annuler' : 'Supprimer'}
        size={38}
        tone="solid"
        onPress={() => (busy ? cancelDownload(e.chapterId) : removeDownload(e.chapterId))}
      />
    </Press>
  );
}

export default function Downloads() {
  const insets = useSafeAreaInsets();
  const all = useDownloads();
  const items = Object.values(all).sort((a, b) => b.createdAt - a.createdAt);
  const bytes = items.reduce((n, e) => n + (e.bytes || 0), 0);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
      <View style={styles.head}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
        <View style={{ flex: 1 }}>
          <Txt v="title">Téléchargements</Txt>
          <Txt v="small">
            {items.length} chapitre{items.length > 1 ? 's' : ''} · {formatBytes(bytes)}
          </Txt>
        </View>
        {items.length > 0 && (
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
        data={items}
        keyExtractor={(e) => e.chapterId}
        renderItem={({ item }) => <Row e={item} />}
        contentContainerStyle={{ padding: S.lg, gap: S.sm, paddingBottom: insets.bottom + S.xl }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="cloud-download-outline" size={40} color={C.text2} />
            <Txt v="label">Aucun chapitre hors-ligne</Txt>
            <Txt v="body" style={{ textAlign: 'center' }}>
              {downloadsSupported
                ? 'Dans le lecteur, touche l’icône de téléchargement pour garder un chapitre sur ton appareil.'
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
  row: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: R.card,
    borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  empty: { alignItems: 'center', gap: S.sm, paddingTop: 80, paddingHorizontal: S.xl },
});
