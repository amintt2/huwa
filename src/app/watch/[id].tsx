import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { languageMismatch } from '@/addons/audio';
import { useAnimeIds } from '@/addons/ids';
import type { NoSourceAction } from '@/addons/no-source';
import { useSubtitles } from '@/addons/registry';
import { subtitleExtraOf } from '@/subtitles/request';
import { isTorrent } from '@/addons/protocol';
import { qualityLabel, useSource } from '@/addons/use-source';
import { EpisodeBridgeStrip } from '@/components/bridge';
import { CommentsPanel } from '@/components/comments';
import { DownloadSheet, statusLine, type PlayingSource } from '@/components/downloads/episode-download';
import { hlsAvailable, useOfflineEpisode, useDownloadItem } from '@/downloads';
import { downloadability, pickForDownload, pickSubtitles } from '@/downloads/pick';
import { getDebrid } from '@/debrid/store';
import { Player, type ExternalSubtitle, type PlayerHandle } from '@/components/player/Player';
import { PrefetchNext } from '@/components/player/prefetch-next';
import { WebPlayer } from '@/components/player/WebPlayer';
import { SourceButton, SourcesMenu } from '@/components/sources-menu';
import { useStreamPolicy } from '@/settings/network';
import { useWatchTrace } from '@/stats/use-watch-trace';
import { useSettings } from '@/settings/settings';
import { ActionTile, Chip, Cover, IconButton, Press, Txt } from '@/components/ui';
import { chapterAfterEpisode } from '@/data/bridge';
import { episodeLabel, getEpisode, useCatalog } from '@/data/catalog';
import { useMappingSync } from '@/data/mapping-sync';
import { useThread } from '@/store/derived';
import { flushPendingWrites } from '@/store/persist';
import { getState, markEpisodeDone, saveEpisodeProgress, toggleMyList, useStore } from '@/store/store';
import { enableTorrentEngine, getTorrentSettings, isAvailable as torrentEngineLinked, useTorrentSettings } from '@/torrent';
import { isStoreBuild } from '@/config/channel';
import { C, R, S, SHADOW } from '@/theme/tokens';

// A player crash stays on this route (retry / back) instead of taking the whole app down.
export { ErrorScreen as ErrorBoundary } from '@/components/error-screen';

export default function Watch() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const found = getEpisode(id);
  if (!found) return <Txt style={{ padding: S.xl }}>Épisode introuvable.</Txt>;
  return <WatchScreen key={id} id={id} />;
}

function WatchScreen({ id }: { id: string }) {
  const insets = useSafeAreaInsets();
  // Chapter ranges change when earlier seasons or community corrections arrive.
  useCatalog();
  const { series, episode } = getEpisode(id)!;
  useMappingSync(series);
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
  const langPrefs = useSettings();
  // Downloaded episode: played from the local file, no addon is asked (works offline).
  const offline = useOfflineEpisode(id);
  const dlItem = useDownloadItem(id);
  const [dlOpen, setDlOpen] = useState(false);

  // ---- Source: auto (first that works, then better quality) or manual via the menu ----
  const torrentSettings = useTorrentSettings();
  const src = useSource(series.id, episode.number, { enabled: !offline, engineAvailable: torrentEngineLinked() && !torrentSettings.enabled });
  // Subtitle addons, asked again with the playing file (hash / size / name) for exact matches.
  const playing = src.current;
  const video = useMemo(() => subtitleExtraOf(playing), [playing]);
  const addonSubs = useSubtitles(series.id, episode.number, !offline, video, langPrefs.subLangs);
  // Start timings (tap → sources → choice → first frame) → on-device stats, see addons/timing.ts.
  useWatchTrace(id, src);
  // Subtitles attached to the playing stream first, then the subtitles addons (e.g. OpenSubtitles).
  const { streamSubtitles } = src;
  const streamAddon = src.current?.addonName ?? 'Flux';
  const offlineSubs = offline?.subtitles;
  const subtitles = useMemo<ExternalSubtitle[]>(() => {
    if (offlineSubs) return offlineSubs.map((x) => ({ url: x.url, lang: x.lang, source: 'Téléchargé', label: x.label ?? '' }));
    const all = [
      ...streamSubtitles.map((x) => ({ url: x.url, lang: x.lang, addonName: streamAddon, match: undefined })),
      ...addonSubs,
    ].filter((x, i, arr) => arr.findIndex((y) => y.url === x.url) === i);
    // Several files of one language from one source: number them ("Piste 2"); files synced to
    // this very video say so.
    return all.map((x) => {
      const same = all.filter((y) => y.lang === x.lang && y.addonName === x.addonName);
      const { match } = x;
      const num = same.length > 1 ? `Piste ${same.indexOf(x) + 1}` : '';
      const label = match ? [num, match === 'hash' ? 'synchro exacte' : 'même release'].filter(Boolean).join(' · ') : num;
      return { url: x.url, lang: x.lang, source: x.addonName, label, match };
    });
  }, [addonSubs, streamSubtitles, streamAddon, offlineSubs]);
  // Loading bar before playback: share of addons that answered, then the race / torrent step.
  const [maxPending, setMaxPending] = useState(0);
  if (src.pending > maxPending) setMaxPending(src.pending);
  const sourceSearch = {
    phase: src.peerRacing ? 'peers' : src.racing || src.deciding || (src.current && !src.url) ? 'race' : src.pending > 0 ? 'search' : null,
    answered: maxPending ? 1 - src.pending / maxPending : 0,
  } as const;
  const [menuOpen, setMenuOpen] = useState(false);
  const [prefetchArmed, setPrefetchArmed] = useState(false);
  const streamPolicy = useStreamPolicy();
  const [notice, setNotice] = useState('');
  // The chosen source doesn't match the user's languages (e.g. no VOSTFR: Spanish audio, English
  // subtitles only): say it instead of letting them find out. Once per source, then a banner.
  // Full tracks the player knows of (embedded in the file once loaded, translation): per source.
  const [playerSubs, setPlayerSubs] = useState<{ key?: string; langs: string[] }>({ langs: [] });
  const knownSubLangs = [...subtitles.map((x) => x.lang), ...(playerSubs.key === src.currentKey ? playerSubs.langs : [])];
  const mismatch = src.current && (src.url || src.web) ? languageMismatch(src.current, langPrefs, knownSubLangs) : null;
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

  // Leaving the episode: the player saves its last position in its own cleanup; write it to disk
  // right after (next tick, once every cleanup ran) instead of waiting for the debounce.
  useEffect(() => () => void setTimeout(() => flushPendingWrites().catch(() => {}), 0), []);

  // A finished episode starts over; a rewatch in progress (position saved again, not at the end)
  // resumes. `done` stays true for the "vu" badge, so it can't decide this alone.
  const startAt = () => {
    const saved = getState().episodes[id];
    if (!saved || !saved.duration) return undefined;
    return saved.position / saved.duration < 0.92 ? saved.position : undefined;
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
  // What "Télécharger" would take from this screen: the source playing now.
  const playingForDownload: PlayingSource | null = (() => {
    if (!src.current) return null;
    const ctx = { debrid: !!getDebrid(), engine: torrentEngineLinked() && getTorrentSettings().enabled, hls: hlsAvailable() };
    const d = downloadability(src.current, ctx);
    return {
      stream: src.current,
      url: src.url,
      via: isTorrent(src.current) ? src.resolverLabel ?? undefined : undefined,
      pick: d.ok ? pickForDownload([src.current], 'auto', ctx) : null,
      reason: d.ok ? undefined : d.reason,
    };
  })();
  const subtitlesForDownload = pickSubtitles(subtitles, langPrefs.subLangs).map((x) => ({ url: x.url, lang: x.lang, label: x.source }));
  const renderComments = () => (
    <CommentsPanel
      target={target}
      kind="anime"
      getTime={() => playerRef.current?.getTime() ?? 0}
      onSeek={(t) => playerRef.current?.seekTo(t)}
    />
  );

  // Tighter rhythm than other screens: on a standard iPhone the bridge card stays above the
  // comment composer instead of being cut by it.
  const header = (
    <View style={{ paddingHorizontal: S.lg, paddingTop: S.md, paddingBottom: S.lg, gap: S.md }}>
      <View style={{ gap: 6 }}>
        <Press onPress={() => router.push(`/anime/${series.id}`)} scaleTo={0.98} accessibilityRole="link" accessibilityLabel={`${series.title}, saison 1. Ouvrir la fiche`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm, alignSelf: 'flex-start', minHeight: 28 }}>
          <Chip kind="anime" />
          <Txt v="small" color={C.body} numberOfLines={1} style={{ flexShrink: 1, fontWeight: '600' }}>{series.title} · S1</Txt>
          <Ionicons name="chevron-forward" size={13} color={C.text3} />
        </Press>
        <Txt v="title" accessibilityRole="header">{episodeLabel(episode)}</Txt>
      </View>

      <View style={styles.tiles}>
        <ActionTile icon={inList ? 'checkmark' : 'add'} label="Ma liste" active={inList} onPress={() => toggleMyList(series.id)} />
        <ActionTile icon="chatbubble-outline" label={count ? `${count}` : 'Commenter'} accessibilityLabel={`Commentaires, ${count}`}
          onPress={() => router.push({ pathname: '/comments', params: { target, kind: 'anime' } })} />
        {/* App Store flavor: no episode downloads (their sources are extensions). */}
        {!isStoreBuild && (
          <ActionTile
            icon={dlItem?.status === 'done' ? 'checkmark-circle' : 'arrow-down-circle-outline'}
            active={dlItem?.status === 'done'}
            label={!dlItem ? 'Télécharger' : dlItem.status === 'done' ? 'Téléchargé' : dlItem.status === 'failed' ? 'Échec' : 'En cours'}
            onPress={() => setDlOpen(true)}
          />
        )}
      </View>

      {offline ? (
        <View style={styles.offline} accessibilityRole="text">
          <Ionicons name="phone-portrait-outline" size={18} color={C.accentText} />
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="label" style={{ fontSize: 14 }}>Lecture du fichier téléchargé</Txt>
            <Txt v="small">{dlItem ? statusLine(dlItem) : ''} · fonctionne sans connexion</Txt>
          </View>
        </View>
      ) : (
        <SourceButton src={src} onOpen={() => setMenuOpen(true)} />
      )}
      {mismatch && (
        <Press onPress={() => setMenuOpen(true)} style={styles.langWarn} accessibilityRole="button" accessibilityLabel={`${mismatch}. Changer de source`}>
          <Ionicons name="language-outline" size={18} color={C.star} style={{ marginTop: 1 }} />
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="label" style={{ fontSize: 14 }}>{mismatch}</Txt>
            <Txt v="small" color={C.body}>Aucune source ne correspond à tes langues pour l’instant. Touche pour choisir une autre source.</Txt>
          </View>
        </Press>
      )}

      {next && (
        <Press onPress={() => router.replace(`/watch/${next.id}`)} style={styles.next} accessibilityLabel={`Suivant : ${episodeLabel(next)}`}>
          <Cover palette={series.palette} image={series.image} width={104} height={60} radius={8} />
          <View style={{ flex: 1, gap: 3 }}>
            <Txt v="caption" color={C.accentText}>À suivre</Txt>
            <Txt v="label" numberOfLines={2}>{episodeLabel(next)}</Txt>
          </View>
          <View style={styles.nextPlay} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Ionicons name="play" size={18} color={C.white} style={{ marginLeft: 2 }} />
          </View>
        </Press>
      )}

      {series.manhwa && (
        <EpisodeBridgeStrip series={series} episode={episode} nextChapterId={nextChapter?.id} />
      )}

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: S.sm }}>
        <Txt v="section" accessibilityRole="header">Commentaires</Txt>
        <Txt v="small" tabular color={C.text3} style={{ fontSize: 14 }}>{count}</Txt>
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
            <IconButton icon="chevron-back" label="Retour" size={40} onPress={() => router.back()} />
            <Txt v="label" color={C.body} numberOfLines={1} style={{ flex: 1, fontSize: 14 }}>{series.title}</Txt>
          </View>
        )}
        {src.web && !offline ? (
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
            source={offline ? { uri: offline.uri } : src.url ? { uri: src.url, headers: src.headers } : null}
            title={series.title}
            subtitle={episodeLabel(episode)}
            artwork={series.image}
            subtitles={subtitles}
            mediaKey={id}
            onSubtitleLangs={(langs) => setPlayerSubs({ key: src.currentKey, langs })}
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
                  : src.peerRacing
                    ? 'Recherche de pairs…'
                  : src.pending > 0
                    ? 'Recherche de sources…'
                    : !src.resolverLabel && src.ranked.some(isTorrent)
                      ? 'Ces sources sont des torrents. Ouvre le menu des sources pour les lire avec le moteur intégré ou un service débrid.'
                      : 'Aucune source lisible. Ouvre le menu des sources.'
            }
            emptyAction={
              noSource?.action && !(isStoreBuild && STORE_HIDDEN_ACTIONS.has(noSource.action.kind))
                ? { label: noSource.action.label, onPress: () => onNoSourceAction(noSource.action!.kind) }
                : null
            }
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
      {dlOpen && (
        <DownloadSheet
          series={series}
          episode={episode}
          visible
          onClose={() => setDlOpen(false)}
          playing={playingForDownload}
          subtitles={subtitlesForDownload}
        />
      )}
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

/** App Store flavor: no extension / debrid / torrent screens to send the user to. */
const STORE_HIDDEN_ACTIONS = new Set<NoSourceAction>(['addons', 'debrid', 'enable-engine']);

const styles = StyleSheet.create({
  offline: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, padding: 14, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: 'rgba(47,107,235,0.08)', borderWidth: 1, borderColor: 'rgba(127,176,255,0.20)',
  },
  langWarn: {
    flexDirection: 'row', alignItems: 'flex-start', gap: S.md, padding: 14, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: 'rgba(255,200,87,0.08)', borderWidth: 1, borderColor: 'rgba(255,200,87,0.24)',
  },
  tiles: { flexDirection: 'row', gap: S.sm, marginLeft: -S.sm },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.md, paddingBottom: S.sm },
  next: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.sm, paddingRight: S.md, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, boxShadow: `${SHADOW.raised}, ${SHADOW.inset}`,
  },
  nextPlay: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: C.accent, boxShadow: SHADOW.insetStrong },
});
