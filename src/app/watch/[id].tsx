import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { languageMismatch } from '@/addons/audio';
import { useAnimeIds } from '@/addons/ids';
import type { NoSourceAction } from '@/addons/no-source';
import { useSubtitles } from '@/addons/registry';
import { isTorrent } from '@/addons/protocol';
import { traceMark } from '@/addons/timing';
import { qualityLabel, useSource } from '@/addons/use-source';
import { EpisodeBridgeStrip } from '@/components/bridge';
import { CommentsPanel } from '@/components/comments';
import { Player, type ExternalSubtitle, type PlayerHandle } from '@/components/player/Player';
import { PrefetchNext } from '@/components/player/prefetch-next';
import { WebPlayer } from '@/components/player/WebPlayer';
import { SourceButton, SourcesMenu } from '@/components/sources-menu';
import { useStreamPolicy } from '@/settings/network';
import { useSettings } from '@/settings/settings';
import { Button, Chip, Cover, IconButton, Press, Txt } from '@/components/ui';
import { chapterAfterEpisode } from '@/data/bridge';
import { episodeLabel, getEpisode } from '@/data/catalog';
import { useThread } from '@/store/derived';
import { getState, markEpisodeDone, saveEpisodeProgress, toggleMyList, useStore } from '@/store/store';
import { enableTorrentEngine, isAvailable as torrentEngineLinked, useTorrentSettings } from '@/torrent';
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
  const [full, setFull] = useState(false);
  const thread = useThread(target);
  const timed = useMemo(
    () => thread.filter((c) => c.timestamp != null && !c.spoiler && !c.parentId)
      .map((c) => ({ id: c.id, author: c.author, text: c.text, timestamp: c.timestamp! }))
      .sort((a, b) => a.timestamp - b.timestamp),
    [thread],
  );
  const ids = useAnimeIds(series.id);
  const addonSubs = useSubtitles(series.id, episode.number);

  // ---- Source: auto (first that works, then better quality) or manual via the menu ----
  const torrentSettings = useTorrentSettings();
  const src = useSource(series.id, episode.number, { engineAvailable: torrentEngineLinked() && !torrentSettings.enabled });
  // Dev timings (tap → sources → choice → first frame), see addons/timing.ts.
  useEffect(() => traceMark(id, 'screen'), [id]);
  const hasSources = src.ranked.length > 0;
  useEffect(() => {
    if (hasSources) traceMark(id, 'sources', src.ranked.some((s) => s.cachedAt != null) ? 'cache disque' : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSources, id]);
  useEffect(() => {
    if (src.currentKey) traceMark(id, 'decision');
  }, [src.currentKey, id]);
  // Subtitles attached to the playing stream first, then the subtitles addons (e.g. OpenSubtitles).
  const { streamSubtitles } = src;
  const streamAddon = src.current?.addonName ?? 'Flux';
  const subtitles = useMemo<ExternalSubtitle[]>(() => {
    const all = [
      ...streamSubtitles.map((x) => ({ url: x.url, lang: x.lang, addonName: streamAddon })),
      ...addonSubs,
    ].filter((x, i, arr) => arr.findIndex((y) => y.url === x.url) === i);
    // Several files of one language from one source: number them ("Piste 2").
    return all.map((x) => {
      const same = all.filter((y) => y.lang === x.lang && y.addonName === x.addonName);
      return { url: x.url, lang: x.lang, source: x.addonName, label: same.length > 1 ? `Piste ${same.indexOf(x) + 1}` : '' };
    });
  }, [addonSubs, streamSubtitles, streamAddon]);
  // Loading bar before playback: share of addons that answered, then the race / torrent step.
  const [maxPending, setMaxPending] = useState(0);
  if (src.pending > maxPending) setMaxPending(src.pending);
  const sourceSearch = {
    phase: src.racing || src.deciding || (src.current && !src.url) ? 'race' : src.pending > 0 ? 'search' : null,
    answered: maxPending ? 1 - src.pending / maxPending : 0,
  } as const;
  const [menuOpen, setMenuOpen] = useState(false);
  const [prefetchArmed, setPrefetchArmed] = useState(false);
  const streamPolicy = useStreamPolicy();
  const [notice, setNotice] = useState('');
  // The chosen source doesn't match the user's languages (e.g. no VOSTFR: Spanish audio, English
  // subtitles only): say it instead of letting them find out. Once per source, then a banner.
  const langPrefs = useSettings();
  const mismatch = src.current && (src.url || src.web) ? languageMismatch(src.current, langPrefs, subtitles.map((x) => x.lang)) : null;
  const [mismatchShown, setMismatchShown] = useState<string | undefined>();
  if (mismatch && src.currentKey && mismatchShown !== src.currentKey) {
    setMismatchShown(src.currentKey);
    setNotice(mismatch);
  }
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(id);
  }, [notice]);
  const currentRef = useRef(src.currentKey);
  useEffect(() => {
    currentRef.current = src.currentKey;
  }, [src.currentKey]);
  // "Better quality found" notice when auto mode upgrades the source mid-episode.
  const loadedQuality = useRef<number | null | undefined>(undefined);
  const onSourceLoaded = () => {
    const from = loadedQuality.current;
    if (from !== undefined && (src.quality ?? 0) > (from ?? 0)) {
      setNotice(`Meilleure qualité trouvée : ${qualityLabel(src.quality)}`);
    }
    loadedQuality.current = src.quality;
  };
  useEffect(() => {
    if (src.url) onSourceLoaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src.url]);

  const startAt = () => {
    const saved = getState().episodes[id];
    return saved && !saved.done ? saved.position : undefined;
  };
  const onProgress = (position: number, duration: number) => {
    saveEpisodeProgress(id, position, duration);
    // Preload the next episode from mid-episode (or the last 5 minutes of a long one).
    if (!prefetchArmed && duration > 0 && (position / duration > 0.5 || duration - position < 300)) setPrefetchArmed(true);
  };
  const onPlayerError = (message: string) => {
    if (currentRef.current) src.markBad(currentRef.current, message);
  };
  const noSource = src.noSource;
  const onNoSourceAction = (kind: NoSourceAction) => {
    if (kind === 'addons') router.push('/addons');
    else if (kind === 'debrid') router.push('/debrid');
    else if (kind === 'sources') setMenuOpen(true);
    else if (kind === 'enable-engine') void enableTorrentEngine();
    else src.retryAll();
  };
  const nextProp = next ? { label: episodeLabel(next), onPlay: () => router.replace(`/watch/${next.id}`) } : null;
  const sourceLabel = (() => {
    if (!src.current) return 'Sources';
    // Addon names often already carry the quality ("HLS 720p"): don't repeat it.
    const name = (src.current.name ?? 'Source').split('\n')[0].trim();
    const q = qualityLabel(src.quality);
    return name.toLowerCase().includes(q.toLowerCase()) ? name : `${name} · ${q}`;
  })();
  const renderComments = () => (
    <CommentsPanel
      target={target}
      kind="anime"
      getTime={() => playerRef.current?.getTime() ?? 0}
      onSeek={(t) => playerRef.current?.seekTo(t)}
    />
  );

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
      {mismatch && (
        <Press onPress={() => setMenuOpen(true)} style={styles.langWarn} accessibilityRole="button" accessibilityLabel={`${mismatch}. Changer de source`}>
          <Ionicons name="language-outline" size={18} color="#F5B544" />
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="label" style={{ fontSize: 14 }}>{mismatch}</Txt>
            <Txt v="small">Aucune source ne correspond à tes langues pour l’instant. Touche pour choisir une autre source.</Txt>
          </View>
        </Press>
      )}

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
    <View style={{ flex: 1, backgroundColor: full ? C.black : C.bg }}>
      {/* Fullscreen landscape: home indicator auto-hidden, no swipe-back (status bar: see Player). */}
      <Stack.Screen options={{ autoHideHomeIndicator: full, gestureEnabled: !full }} />
      <View style={full ? { flex: 1, backgroundColor: C.black } : { paddingTop: insets.top, backgroundColor: C.black }}>
        {!full && (
          <View style={styles.topBar}>
            <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
            <Txt v="small" numberOfLines={1} style={{ flex: 1 }}>{series.title}</Txt>
          </View>
        )}
        {src.web ? (
          // Hosted player page (addon `externalUrl` / HTML `url`): shown in place of the native player.
          <WebPlayer
            key={src.web.url}
            ref={playerRef}
            url={src.web.url}
            title={series.title}
            subtitle={episodeLabel(episode)}
            malId={ids?.mal}
            episodeNumber={episode.number}
            notice={notice}
            startAt={startAt}
            onProgress={onProgress}
            onEnd={() => markEpisodeDone(id)}
            onError={onPlayerError}
            next={nextProp}
            onFullscreenChange={setFull}
            onOpenSources={() => setMenuOpen(true)}
            sourceLabel={sourceLabel}
            commentCount={count}
            renderComments={renderComments}
          />
        ) : (
          <Player
            ref={playerRef}
            source={src.url ? { uri: src.url, headers: src.headers } : null}
            title={series.title}
            subtitle={episodeLabel(episode)}
            artwork={series.image}
            subtitles={subtitles}
            mediaKey={id}
            malId={ids?.mal}
            episodeNumber={episode.number}
            notice={notice}
            sourceSearch={sourceSearch}
            emptyTitle={noSource?.title}
            emptyText={
              noSource
                ? noSource.message
                : src.racing
                  ? 'Test de la vitesse des sources…'
                  : src.pending > 0
                    ? 'Recherche de sources…'
                    : !src.resolverLabel && src.ranked.some(isTorrent)
                      ? 'Ces sources sont des torrents. Ouvre le menu des sources pour les lire avec le moteur intégré ou un service débrid.'
                      : 'Aucune source lisible. Ouvre le menu des sources.'
            }
            emptyAction={noSource?.action ? { label: noSource.action.label, onPress: () => onNoSourceAction(noSource.action!.kind) } : null}
            startAt={startAt}
            onProgress={onProgress}
            onEnd={() => markEpisodeDone(id)}
            onError={onPlayerError}
            next={nextProp}
            onFullscreenChange={setFull}
            onOpenSources={() => setMenuOpen(true)}
            sourceLabel={sourceLabel}
            commentCount={count}
            timedComments={timed}
            renderComments={renderComments}
            upgrade={src.upgrade}
            onUpgraded={src.adoptUpgrade}
            onUpgradeDeferred={src.deferUpgrade}
          />
        )}
      </View>
      <SourcesMenu src={src} visible={menuOpen} onClose={() => setMenuOpen(false)} />
      {next && <PrefetchNext seriesId={series.id} episode={next.number} armed={prefetchArmed} buffer={streamPolicy.allowed} />}
      {/* Hidden, not unmounted, in fullscreen: keeps the comment draft and scroll position. */}
      <View style={{ flex: 1, display: full ? 'none' : 'flex' }}>
        <CommentsPanel
          target={target}
          kind="anime"
          header={header}
          getTime={() => playerRef.current?.getTime() ?? 0}
          onSeek={(t) => playerRef.current?.seekTo(t)}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  langWarn: {
    flexDirection: 'row', alignItems: 'flex-start', gap: S.md, marginHorizontal: S.lg, padding: S.md, borderRadius: 14,
    backgroundColor: 'rgba(245,181,68,0.12)', borderWidth: 1, borderColor: 'rgba(245,181,68,0.35)',
  },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.md, paddingBottom: S.sm },
  next: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: 10, borderRadius: 16, backgroundColor: C.surface },
  nextPlay: { borderRadius: 20, overflow: 'hidden', backgroundColor: C.accent },
});
