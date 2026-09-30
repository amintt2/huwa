import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isPlayable, type AddonStream } from '@/addons/protocol';
import { useStreams } from '@/addons/registry';
import { EpisodeBridgeStrip } from '@/components/bridge';
import { CommentsPanel } from '@/components/comments';
import { Player, type ExternalSubtitle, type PlayerHandle } from '@/components/player/Player';
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
  const playerRef = useRef<PlayerHandle>(null);

  const { streams, pending, failed } = useStreams(series.id, episode.number);
  const [picked, setPicked] = useState<AddonStream | undefined>();
  const source = picked ?? streams.find(isPlayable);
  // External SRT/VTT files for this episode (wired to useSubtitles when available).
  const subtitles: ExternalSubtitle[] = [];
  const headers = source?.behaviorHints?.proxyHeaders?.request;

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
        <Player
          ref={playerRef}
          source={source?.url ? { uri: source.url, headers } : null}
          title={series.title}
          subtitle={episodeLabel(episode)}
          artwork={series.image}
          subtitles={subtitles}
          emptyText={pending > 0 ? 'Recherche de sources…' : 'Choisis une source ci-dessous.'}
          startAt={() => {
            const saved = getState().episodes[id];
            return saved && !saved.done ? saved.position : undefined;
          }}
          onProgress={(position, duration) => saveEpisodeProgress(id, position, duration)}
          onEnd={() => markEpisodeDone(id)}
          next={next ? { label: episodeLabel(next), onPlay: () => router.replace(`/watch/${next.id}`) } : null}
        />
      </View>
      <CommentsPanel
        target={target}
        kind="anime"
        header={header}
        getTime={() => playerRef.current?.getTime() ?? 0}
        onSeek={(t) => playerRef.current?.seekTo(t)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.md, paddingBottom: S.sm },
  source: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: 14, backgroundColor: C.surface },
  next: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: 10, borderRadius: 16, backgroundColor: C.surface },
  nextPlay: { borderRadius: 20, overflow: 'hidden', backgroundColor: C.accent },
});
