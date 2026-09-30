import { useEventListener } from 'expo';
import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isPlayable, type AddonStream } from '@/addons/protocol';
import { useStreams } from '@/addons/registry';
import { EpisodeBridgeStrip } from '@/components/bridge';
import { CommentsPanel } from '@/components/comments';
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

  const { streams, pending, failed } = useStreams(series.id, episode.number);
  const [picked, setPicked] = useState<AddonStream | undefined>();
  const source = picked ?? streams.find(isPlayable);
  const resumed = useRef(false);

  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 1;
  });

  const headers = source?.behaviorHints?.proxyHeaders?.request;
  const headersKey = JSON.stringify(headers ?? {});
  useEffect(() => {
    if (!source?.url) return;
    resumed.current = false;
    player.replaceAsync({ uri: source.url, headers }).then(() => {
      const saved = getState().episodes[id];
      if (!resumed.current && saved && !saved.done && saved.position > 5) player.currentTime = saved.position;
      resumed.current = true;
      player.play();
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.url, headersKey, player, id]);

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

      <View style={{ gap: S.sm }}>
        <Txt v="section">Sources</Txt>
        {streams.map((st, i) => {
          const ok = isPlayable(st);
          const active = ok && st.url === source?.url;
          return (
            <Press
              key={`${st.addonId}-${i}`}
              disabled={!ok && !st.externalUrl}
              onPress={() => (ok ? setPicked(st) : st.externalUrl && Linking.openURL(st.externalUrl))}
              style={[styles.source, active && { backgroundColor: C.accentSoft }, !ok && !st.externalUrl && { opacity: 0.45 }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt v="label" numberOfLines={1}>{(st.name ?? 'Flux') + (st.title ? ` · ${st.title.split('\n')[0]}` : '')}</Txt>
                <Txt v="small" numberOfLines={1}>
                  {st.addonName}{ok ? '' : st.infoHash ? ' · torrent (non supporté)' : st.externalUrl ? ' · ouvre le navigateur' : ''}
                </Txt>
              </View>
              {active && <Chip kind="accent" label="EN COURS" />}
            </Press>
          );
        })}
        {pending > 0 && <Txt v="small">Recherche de sources… ({pending})</Txt>}
        {pending === 0 && streams.length === 0 && (
          <Txt v="small">Aucune source. Active ou installe un addon dans Profil → Addons.</Txt>
        )}
        {failed.length > 0 && <Txt v="small">Injoignable : {failed.join(', ')}</Txt>}
      </View>

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
      </View>
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
  source: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: 14, backgroundColor: C.surface },
  next: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: 10, borderRadius: 16, backgroundColor: C.surface },
  nextPlay: { borderRadius: 20, overflow: 'hidden', backgroundColor: C.accent },
});
