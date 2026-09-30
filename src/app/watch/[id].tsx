import { useEventListener } from 'expo';
import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { qualityLabel, useSource } from '@/addons/use-source';
import { EpisodeBridgeStrip } from '@/components/bridge';
import { CommentsPanel } from '@/components/comments';
import { SourceButton, SourcesMenu } from '@/components/sources-menu';
import { Button, Chip, Cover, IconButton, Press, Txt } from '@/components/ui';
import { chapterAfterEpisode } from '@/data/bridge';
import { episodeLabel, getEpisode } from '@/data/catalog';
import { useThread } from '@/store/derived';
import { getState, markEpisodeDone, saveEpisodeProgress, toggleMyList, useStore } from '@/store/store';
import { C, S } from '@/theme/tokens';

export default function Watch() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const found = getEpisode(id);
  if (!found) return <Txt style={{ padding: S.xl }}>Épisode introuvable.</Txt>;
  return <WatchScreen key={id} id={id} />;
}

function WatchScreen({ id }: { id: string }) {
  const insets = useSafeAreaInsets();
  const { series, episode } = getEpisode(id)!;
  const eps = series.anime!.episodes;
  const next = eps.find((e) => e.number === episode.number + 1);
  const nextChapter = chapterAfterEpisode(series, episode);
  const inList = useStore((s) => s.myList.includes(series.id));
  const target = `ep:${id}`;
  const count = useThread(target).length;
  const lastSave = useRef(0);

  // ---- Source: auto (first that works, then better quality) or manual via the menu ----
  const src = useSource(series.id, episode.number);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const currentRef = useRef(src.currentKey);
  useEffect(() => {
    currentRef.current = src.currentKey;
  }, [src.currentKey]);
  const loadedQuality = useRef<number | null | undefined>(undefined);
  const resumed = useRef(false);

  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 1;
  });

  // Playback failure → next source in the ranked list.
  useEventListener(player, 'statusChange', ({ status, error }) => {
    if (status === 'error' && currentRef.current) src.markBad(currentRef.current, error?.message ?? 'Lecture impossible');
  });

  const headersKey = JSON.stringify(src.headers ?? {});
  useEffect(() => {
    if (!src.url) return;
    // Switching source mid-episode (quality upgrade, fallback, manual pick) keeps the position.
    const at = resumed.current ? player.currentTime : undefined;
    const upgradedFrom = loadedQuality.current;
    const quality = src.quality;
    resumed.current = false;
    player.replaceAsync({ uri: src.url, headers: src.headers }).then(() => {
      const saved = getState().episodes[id];
      if (at != null && at > 1) player.currentTime = at;
      else if (saved && !saved.done && saved.position > 5) player.currentTime = saved.position;
      resumed.current = true;
      player.play();
      if (upgradedFrom !== undefined && (quality ?? 0) > (upgradedFrom ?? 0)) {
        setNotice(`Meilleure qualité trouvée : ${qualityLabel(quality)}`);
        setTimeout(() => setNotice(''), 3500);
      }
      loadedQuality.current = quality;
    }).catch(() => {
      if (currentRef.current) src.markBad(currentRef.current, 'Lecture impossible');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src.url, headersKey, player, id]);

  // Persist progress every 5 s and when leaving the screen.
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    if (Date.now() - lastSave.current < 5000) return;
    lastSave.current = Date.now();
    saveEpisodeProgress(id, currentTime, player.duration);
  });
  useEventListener(player, 'playToEnd', () => markEpisodeDone(id));
  useEffect(() => () => {
    try {
      saveEpisodeProgress(id, player.currentTime, player.duration);
    } catch {
      // player already released
    }
  }, [id, player]);

  const header = (
    <View style={{ padding: S.lg, gap: S.lg }}>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
          <Chip kind="anime" />
          <Press onPress={() => router.push(`/anime/${series.id}`)}>
            <Txt v="small" style={{ fontSize: 13 }}>{series.title} · S1</Txt>
          </Press>
        </View>
        <Txt v="title">{episodeLabel(episode)}</Txt>
      </View>

      <View style={{ flexDirection: 'row', gap: S.sm, flexWrap: 'wrap' }}>
        <Button small variant="soft" icon={inList ? 'checkmark' : 'add'} label="Ma liste" onPress={() => toggleMyList(series.id)} />
        <Button small variant="soft" icon="chatbubble-outline" label={`${count}`}
          onPress={() => router.push({ pathname: '/comments', params: { target, kind: 'anime' } })} />
      </View>

      <SourceButton src={src} onOpen={() => setMenuOpen(true)} />

      {next && (
        <Press onPress={() => router.replace(`/watch/${next.id}`)} style={styles.next} accessibilityLabel={`Suivant : ${episodeLabel(next)}`}>
          <Cover palette={series.palette} image={series.image} width={96} height={56} radius={10} />
          <View style={{ flex: 1, gap: 3 }}>
            <Txt v="caption" color={C.accentText}>À SUIVRE</Txt>
            <Txt v="label" numberOfLines={1}>{episodeLabel(next)}</Txt>
          </View>
          <View style={styles.nextPlay}>
            <IconButton icon="play" label="Lire" size={40} tone="solid" color={C.white} onPress={() => router.replace(`/watch/${next.id}`)} />
          </View>
        </Press>
      )}

      {series.manhwa && (
        <EpisodeBridgeStrip from={episode.chapters[0]} to={episode.chapters[1]} nextChapterId={nextChapter?.id} estimated={series.estimated} />
      )}

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: S.sm }}>
        <Txt v="section">Commentaires</Txt>
        <Txt v="small" style={{ fontSize: 14 }}>{count}</Txt>
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingTop: insets.top, backgroundColor: C.black }}>
        <View style={styles.topBar}>
          <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
          <Txt v="small" numberOfLines={1} style={{ flex: 1 }}>{series.title}</Txt>
        </View>
        <VideoView
          player={player}
          style={styles.video}
          nativeControls
          allowsPictureInPicture
          contentFit="contain"
        />
        {!!notice && (
          <View style={styles.notice} pointerEvents="none">
            <Txt v="small" color={C.white}>{notice}</Txt>
          </View>
        )}
      </View>
      <SourcesMenu src={src} visible={menuOpen} onClose={() => setMenuOpen(false)} />
      <CommentsPanel
        target={target}
        kind="anime"
        header={header}
        getTime={() => player.currentTime}
        onSeek={(t) => {
          player.seekBy(t - player.currentTime);
          player.play();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.md, paddingBottom: S.sm },
  video: { width: '100%', aspectRatio: 16 / 9, backgroundColor: C.black },
  notice: { position: 'absolute', bottom: S.md, alignSelf: 'center', paddingHorizontal: S.md, paddingVertical: 6, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.7)' },
  next: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: 10, borderRadius: 16, backgroundColor: C.surface },
  nextPlay: { borderRadius: 20, overflow: 'hidden', backgroundColor: C.accent },
});
