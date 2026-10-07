import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useLocalSearchParams, useNavigation } from 'expo-router';
import type { AudioTrack } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { dubName, languageMismatch, noDubTitle } from '@/addons/audio';
import { nextDubState, recordSeriesDub, setDubChoice, showDubPrompt, useDubChoice, useKnownNoDub } from '@/addons/dub';
import { releaseFamily, setTracks, verifiedAudio } from '@/addons/track-info';
import { DubSheet } from '@/components/dub-sheet';
import { audioVerdict, langCode, pickAudioTrack } from '@/components/player/engines/tracks';
import type { NextDubReport } from '@/components/player/prefetch-next';
import type { DubOutcome } from '@/stats/model';
import { recordDub } from '@/stats/store';
import { useAnimeIds } from '@/addons/ids';
import type { NoSourceAction } from '@/addons/no-source';
import { useSubtitles } from '@/addons/registry';
import { subtitleExtraOf } from '@/subtitles/request';
import { isTorrent } from '@/addons/protocol';
import type { Quality } from '@/addons/quality';
import { qualityLabel, useSource } from '@/addons/use-source';
import { useSourceController } from '@/addons/use-source-controller';
import { PlaybackMonitor } from '@/components/player/playback-monitor';
import { SWITCH_REASON_LABEL } from '@/stats/model';
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
import { usePrewarm } from '@/settings/network';
import { useWatchTrace } from '@/stats/use-watch-trace';
import { useSettings } from '@/settings/settings';
import { ActionTile, Chip, Cover, IconButton, Press, Txt } from '@/components/ui';
import { chapterAfterEpisode } from '@/data/bridge';
import { episodeLabel, getEpisode, useCatalog } from '@/data/catalog';
import { useMappingSync } from '@/data/mapping-sync';
import { useCommunityThread } from '@/p2p/community-hooks';
import { numericParam, registerSeekTarget } from '@/social/anchor-nav';
import { commentAnchor } from '@/social/anchors';
import { extractGif } from '@/social/gif';
import { plainText } from '@/social/markdown';
import { useThread } from '@/store/derived';
import { flushPendingWrites } from '@/store/persist';
import { getState, markEpisodeDone, saveEpisodeProgress, toggleMyList, useStore } from '@/store/store';
import { enableTorrentEngine, getTorrentSettings, isAvailable as torrentEngineLinked, useTorrentSettings } from '@/torrent';
import { isStoreBuild } from '@/config/channel';
import { C, R, S, SHADOW } from '@/theme/tokens';

// A player crash stays on this route (retry / back) instead of taking the whole app down.
export { ErrorScreen as ErrorBoundary } from '@/components/error-screen';

export default function Watch() {
  // `t`: start at this second (comment anchors, huwa://watch/<ep>?t=767 links).
  const { id, t } = useLocalSearchParams<{ id: string; t?: string }>();
  const found = getEpisode(id);
  if (!found) return <Txt style={{ padding: S.xl }}>Épisode introuvable.</Txt>;
  return <WatchScreen key={id} id={id} at={numericParam(t, 86400)} />;
}

function WatchScreen({ id, at }: { id: string; at?: number }) {
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
  const { visible: thread } = useCommunityThread(target);
  // Anchored comments over the video and on the scrubber: moments and ranges, plain text (no
  // spoiler, no community-hidden comment, no GIF link).
  const timed = useMemo(
    () => thread.flatMap((c) => {
      if (c.deleted || c.verdict.spoiler || c.community?.hidden || c.parentId) return [];
      const { anchor, body } = commentAnchor(c);
      if (anchor?.type !== 'time') return [];
      const text = plainText(extractGif(body).text) || 'GIF';
      return [{ id: c.id, author: c.authorName, text, timestamp: anchor.start, end: anchor.end }];
    }).sort((a, b) => a.timestamp - b.timestamp),
    [thread],
  );
  // A comment chip tapped in the comments sheet seeks this player in place.
  const pendingSeek = useRef(at);
  useEffect(() => registerSeekTarget(id, (s) => playerRef.current?.seekTo(s)), [id]);
  // Same episode reopened with another `t` (deep link while playing): seek there.
  const firstAt = useRef(true);
  useEffect(() => {
    if (firstAt.current) {
      firstAt.current = false;
      return;
    }
    if (at !== undefined) playerRef.current?.seekTo(at);
  }, [at]);
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
  const playingVideo = useMemo(() => subtitleExtraOf(playing), [playing]);
  // Automatic source switches keep the subtitles: the addons are not asked again for the new
  // file, and the files shipped with the sources left stay in the list (the selected track, its
  // translation and its sync offset carry on). A source picked by hand asks again.
  const [firstVideo, setFirstVideo] = useState(playingVideo);
  if (!firstVideo && playingVideo) setFirstVideo(playingVideo);
  const video = src.auto ? (firstVideo ?? playingVideo) : playingVideo;
  const addonSubs = useSubtitles(series.id, episode.number, !offline, video, langPrefs.subLangs);
  // Start timings (tap → sources → choice → first frame) → on-device stats, see addons/timing.ts.
  useWatchTrace(id, src);
  // Subtitles attached to the playing stream first, then the subtitles addons (e.g. OpenSubtitles).
  const streamAddon = src.current?.addonName ?? 'Flux';
  const [streamSubs, setStreamSubs] = useState<{ key?: string; list: { url: string; lang: string; addonName: string }[] }>({ list: [] });
  if (streamSubs.key !== src.currentKey) {
    const own = src.streamSubtitles.map((x) => ({ url: x.url, lang: x.lang, addonName: streamAddon }));
    setStreamSubs({ key: src.currentKey, list: src.auto ? [...own, ...streamSubs.list] : own });
  }
  const streamSubtitles = streamSubs.list;
  const offlineSubs = offline?.subtitles;
  const subtitles = useMemo<ExternalSubtitle[]>(() => {
    if (offlineSubs) return offlineSubs.map((x) => ({ url: x.url, lang: x.lang, source: 'Téléchargé', label: x.label ?? '' }));
    const all = [
      ...streamSubtitles.map((x) => ({ url: x.url, lang: x.lang, addonName: x.addonName, match: undefined })),
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
  }, [addonSubs, streamSubtitles, offlineSubs]);
  // Loading bar before playback: share of addons that answered, then the race / torrent step.
  const [maxPending, setMaxPending] = useState(0);
  if (src.pending > maxPending) setMaxPending(src.pending);
  const sourceSearch = {
    phase: src.peerRacing ? 'peers' : src.racing || src.deciding || (src.current && !src.url) ? 'race' : src.pending > 0 ? 'search' : null,
    answered: maxPending ? 1 - src.pending / maxPending : 0,
  } as const;
  const [menuOpen, setMenuOpen] = useState(false);
  const [prefetchArmed, setPrefetchArmed] = useState(false);
  // Next episode buffered ahead: Wi-Fi and cellular "équilibré", not in Low Data Mode / "économie".
  const prewarmNext = usePrewarm();
  const [notice, setNotice] = useState('');
  // ---- dub mode (addons/dub.ts): the search only plays dubbed sources while any exists ----
  const dub = src.dub;
  const dubLangs = langPrefs.dubLangs;
  const [openedAt] = useState(() => Date.now());
  /**
   * The episode's dub outcome for the statistics, recorded when the screen closes (the last one
   * wins: a "dubbed" source whose file had no dub track is not a hit). Track misses are recorded
   * as they happen.
   */
  const dubStat = useRef<{ outcome: DubOutcome; verified?: boolean; ms: number } | null>(null);
  const dubPhaseSeen = useRef(dub.phase);
  useEffect(() => {
    dubPhaseSeen.current = dub.phase;
  }, [dub.phase]);
  useEffect(
    () => () => {
      const o = dubStat.current ?? (dubPhaseSeen.current === 'missing' ? { outcome: 'refused' as const, ms: Date.now() - openedAt } : null);
      if (o) recordDub({ at: Date.now(), ...o });
    },
    [openedAt],
  );
  const noteDubStat = (outcome: DubOutcome, verified?: boolean) => {
    if (outcome === 'track-miss') return recordDub({ at: Date.now(), outcome, ms: Date.now() - openedAt });
    if (dubStat.current?.outcome !== outcome) dubStat.current = { outcome, verified, ms: Date.now() - openedAt };
  };
  const verifiedNow = dub.mode && src.current ? verifiedAudio(src.trackKeysOf(src.current), releaseFamily(src.current)) : null;
  const playingUrl = !!(src.url || src.web);
  const dubOutcome: DubOutcome | null = !dub.mode || offline || !playingUrl
    ? null
    : !src.auto
      ? dub.choice === 'menu' ? 'manual' : null
      : dub.playing
        ? 'hit'
        : dub.phase === 'fallback'
          ? dub.choice === 'fallback' ? 'fallback' : 'auto-fallback'
          : null;
  const dubVerified = !!verifiedNow?.langs.some((l) => dubLangs.includes(l));
  useEffect(() => {
    if (!dubOutcome) return;
    noteDubStat(dubOutcome, dubOutcome === 'hit' ? dubVerified : undefined);
    if (dubOutcome === 'hit') recordSeriesDub(series.id, episode.number, true);
    // Once per outcome (the verification may arrive later: kept as first seen).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dubOutcome]);
  // No dub once every addon answered: remembered for the series (the next episode asks sooner).
  const noDubFound = dub.mode && !offline && (dub.phase === 'missing' || (dub.phase === 'fallback' && !dub.playing)) && src.pending === 0;
  useEffect(() => {
    if (noDubFound) recordSeriesDub(series.id, episode.number, false);
  }, [noDubFound, series.id, episode.number]);
  const knownNoDub = useKnownNoDub(series.id, episode.number);
  const promptVisible = !offline && showDubPrompt(dub.phase, dub.choice);
  /** Runs once the popup is gone (iOS presents one modal at a time: the sources menu waits). */
  const afterPrompt = useRef<(() => void) | null>(null);
  const chooseFallback = () => setDubChoice(series.id, episode.number, 'fallback');
  const chooseSources = () => {
    afterPrompt.current = () => setMenuOpen(true);
    setDubChoice(series.id, episode.number, 'menu');
  };
  const chooseBack = () => {
    noteDubStat('refused');
    setDubChoice(series.id, episode.number, 'back');
    router.back();
  };
  const noDubLine = `${noDubTitle(dub.lang)} pour cet épisode`;
  // The chosen source doesn't match the user's languages (e.g. no VOSTFR: Spanish audio, English
  // subtitles only): say it instead of letting them find out. Once per source, then a banner.
  // Full tracks the player knows of (embedded in the file once loaded, translation): per source.
  const [playerSubs, setPlayerSubs] = useState<{ key?: string; langs: string[] }>({ langs: [] });
  const knownSubLangs = [...subtitles.map((x) => x.lang), ...(playerSubs.key === src.currentKey ? playerSubs.langs : [])];
  const mismatch = src.current && (src.url || src.web) ? languageMismatch(src.current, langPrefs, knownSubLangs, verifiedNow) : null;
  const [mismatchShown, setMismatchShown] = useState<string | undefined>();
  if (mismatch && src.currentKey && mismatchShown !== src.currentKey) {
    setMismatchShown(src.currentKey);
    // Dub mode: the user chose this version (popup, menu); the setting's automatic switch says so.
    if (!dub.mode) setNotice(mismatch);
    else if (src.auto && dub.phase === 'fallback' && dub.choice !== 'fallback') setNotice(`${noDubTitle(dub.lang)} : lecture en ${dub.fallback ?? 'VO'}`);
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
  // Source controller: better / smoother source while playing, wrong work dropped (see
  // addons/source-controller.ts). The player reports what it observes through `monitor`.
  const [monitor] = useState(() => new PlaybackMonitor());
  const ctl = useSourceController(src, monitor, {
    episode: { officialMin: episode.officialMin, edge: episode.number === 1 || episode.number === eps.length },
    enabled: !offline,
  });
  // Discreet toast when the source changed by itself ("Qualité améliorée · 1080p → 2160p").
  const [toastSeen, setToastSeen] = useState<number | undefined>();
  if (ctl.toast && toastSeen !== ctl.toast.at) {
    setToastSeen(ctl.toast.at);
    setNotice(ctl.toast.text);
  }

  // Leaving the episode: the player saves its last position in its own cleanup; write it to disk
  // right after (next tick, once every cleanup ran) instead of waiting for the debounce.
  useEffect(() => () => void setTimeout(() => flushPendingWrites().catch(() => {}), 0), []);
  // The screen is being removed (back, replaced by another episode): silent from that moment, not
  // only once the native screen is gone after its exit transition.
  const navigation = useNavigation();
  useEffect(() => navigation.addListener('beforeRemove', () => playerRef.current?.stop()), [navigation]);

  // A finished episode starts over; a rewatch in progress (position saved again, not at the end)
  // resumes. `done` stays true for the "vu" badge, so it can't decide this alone.
  const startAt = () => {
    if (pendingSeek.current !== undefined) {
      const s = pendingSeek.current;
      pendingSeek.current = undefined;
      return s;
    }
    const saved = getState().episodes[id];
    if (!saved || !saved.duration) return undefined;
    return saved.position / saved.duration < 0.92 ? saved.position : undefined;
  };
  const onProgress = (position: number, duration: number) => {
    saveEpisodeProgress(id, position, duration);
    // Preload the next episode from mid-episode (or the last 5 minutes of a long one).
    if (!prefetchArmed && duration > 0 && (position / duration > 0.5 || duration - position < 300)) setPrefetchArmed(true);
  };
  // The loaded file's audio tracks are the final check: a "dubbed" source without a track in the
  // dub language is skipped like a broken one (before playback starts: the load has not played
  // yet), and what the file holds is remembered for its release (next episode).
  const [offlineDub, setOfflineDub] = useState(false);
  const onAudioTracks = (uri: string, tracks: AudioTrack[]) => {
    if (langPrefs.watchMode !== 'dub') return;
    if (offline) {
      setOfflineDub(pickAudioTrack(tracks, dubLangs) >= 0);
      return;
    }
    const cur = src.current;
    const key = src.currentKey;
    if (!cur || !key || uri !== src.url) return;
    const keys = src.trackKeysOf(cur);
    const audio = tracks.map((t) => ({ lang: langCode(t.language), name: t.label || t.name || undefined }));
    if (keys[0]) setTracks(keys[0], { audio, subs: [], complete: true, via: 'player', at: Date.now() }, releaseFamily(cur));
    if (!src.auto || !dub.playing) return;
    const v = audioVerdict(tracks);
    if (v.conclusive && !dubLangs.some((l) => v.langs.includes(l))) {
      noteDubStat('track-miss');
      ctl.onFailed(key);
      src.markBad(key, `Pas de piste audio en ${dubName(dub.lang)}`, true);
    }
  };
  const onPlayerError = (message: string) => {
    if (!currentRef.current) return;
    ctl.onFailed(currentRef.current);
    src.markBad(currentRef.current, message);
  };
  const noSource = src.noSource;
  const onNoSourceAction = (kind: NoSourceAction) => {
    if (kind === 'addons') router.push('/addons');
    else if (kind === 'debrid') router.push('/debrid');
    else if (kind === 'sources') setMenuOpen(true);
    else if (kind === 'enable-engine') void enableTorrentEngine();
    else src.retryAll();
  };
  // Next episode (player pill / countdown, "À suivre" card): this episode stops before the
  // navigation, and repeated taps within a second navigate once.
  // Dub mode: the next episode's search (prefetch) or what the series taught says whether it has a
  // dub; without one the card / countdown asks ("Ép. 13 non disponible en VF") — never a silent
  // switch of language.
  const [nextDub, setNextDub] = useState<NextDubReport | null>(null);
  const nextChoice = useDubChoice(series.id, next?.number ?? -1);
  const nextKnownNoDub = useKnownNoDub(series.id, next?.number ?? -1);
  const nextState = !next || langPrefs.watchMode !== 'dub'
    ? 'unknown'
    : nextDub
      ? nextDubState(nextDub.phase, nextChoice)
      : nextKnownNoDub && nextChoice !== 'fallback' ? 'missing' : 'unknown';
  const nextFallback = nextDub?.fallback ?? (langPrefs.subLangs[0] === 'fr' ? 'VOSTFR' : 'VO');
  const [nextAsk, setNextAsk] = useState(false);
  const lastNext = useRef(0);
  const leaveForNext = () => {
    if (!next) return;
    playerRef.current?.stop();
    router.replace(`/watch/${next.id}`);
  };
  const acceptNext = () => {
    if (!next) return;
    setDubChoice(series.id, next.number, 'fallback');
    setNextAsk(false);
    leaveForNext();
  };
  /** "Ép. 13 non disponible en VF": the next episode has no dub (asked before leaving). */
  const nextWarnTitle = next && nextState === 'missing' && !langPrefs.dubAutoFallback ? `Ép. ${next.number} non disponible en ${dubName(dub.lang)}` : null;
  const goNext = () => {
    if (!next || tappedRecently(lastNext)) return;
    if (nextWarnTitle) return setNextAsk(true);
    leaveForNext();
  };
  const nextProp = next
    ? { label: episodeLabel(next), onPlay: goNext, warning: nextWarnTitle ? { title: nextWarnTitle, accept: `Regarder en ${nextFallback}`, onAccept: acceptNext } : null }
    : null;
  const sourceLabel = (() => {
    if (!src.current) return 'Sources';
    // Addon names often already carry the quality ("HLS 720p"): don't repeat it.
    const name = (src.current.name ?? 'Source').split('\n')[0].trim();
    const q = qualityLabel(src.quality);
    return name.toLowerCase().includes(q.toLowerCase()) ? name : `${name} · ${q}`;
  })();
  // "Réglages de lecture" sheet: what plays, and what the automatic switching did last.
  const sourceInfo = src.current
    ? {
        label: `${sourceLabel} · ${src.playingTorrent ? 'torrent' : src.web ? 'lecteur web' : 'lien direct'}`,
        detail: !src.auto
          ? 'Source choisie à la main'
          : !langPrefs.autoSwitchSource
            ? 'Changement de source automatique désactivé'
            : ctl.last
              ? `Changée automatiquement (${SWITCH_REASON_LABEL[ctl.last.reason]}${ctl.last.toRes && ctl.last.fromRes ? ` · ${qualityLabel(ctl.last.fromRes as Quality)} → ${qualityLabel(ctl.last.toRes as Quality)}` : ''})`
              : 'Changement de source automatique activé',
      }
    : undefined;
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
        <Press onPress={goNext} style={styles.next} accessibilityLabel={`Suivant : ${episodeLabel(next)}`}>
          <Cover palette={series.palette} image={series.image} width={104} height={60} radius={8} />
          <View style={{ flex: 1, gap: 3 }}>
            <Txt v="caption" color={C.accentText}>À suivre</Txt>
            <Txt v="label" numberOfLines={2}>{episodeLabel(next)}</Txt>
            {!!nextWarnTitle && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Ionicons name="language-outline" size={13} color={C.star} />
                <Txt v="small" color={C.star} numberOfLines={1} style={{ flex: 1 }}>{nextWarnTitle}</Txt>
              </View>
            )}
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
            emptyTitle={dub.phase === 'missing' ? noDubLine : noSource?.title}
            emptyText={
              dub.phase === 'missing'
                ? dub.fallback ? `Il existe une version ${dub.fallback}. Tu peux aussi choisir une source.` : 'Choisis une source dans le menu.'
                : noSource
                ? noSource.message
                : dub.checking
                  ? 'Vérification de la piste audio…'
                  : dub.phase === 'searching'
                    ? `Recherche de la ${dubName(dub.lang)}…`
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
              dub.phase === 'missing'
                ? dub.fallback ? { label: `Regarder en ${dub.fallback}`, onPress: chooseFallback } : { label: 'Choisir une source', onPress: () => setMenuOpen(true) }
                : noSource?.action && !(isStoreBuild && STORE_HIDDEN_ACTIONS.has(noSource.action.kind))
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
            upgrade={src.auto ? ctl.request : null}
            onUpgraded={ctl.onSwapped}
            onUpgradeDeferred={ctl.onDeferred}
            monitor={monitor}
            sourceInfo={sourceInfo}
            audioLangs={offline ? (offlineDub ? dubLangs : null) : dub.playing ? dubLangs : null}
            onAudioTracks={onAudioTracks}
          />
        )}
      </View>
      <SourcesMenu src={src} visible={menuOpen} onClose={() => setMenuOpen(false)} />
      <DubSheet
        visible={promptVisible}
        title={noDubLine}
        message={`Aucune source en ${dubName(dub.lang)} n’a été trouvée${knownNoDub ? ' (comme pour l’épisode précédent)' : ''}.${dub.fallback ? ` Tu peux le regarder en ${dub.fallback}.` : ''}`}
        fallback={dub.fallback}
        onFallback={chooseFallback}
        onSources={chooseSources}
        onBack={chooseBack}
        // Swiped away: decided later (the player offers the same choices).
        onClose={() => setDubChoice(series.id, episode.number, 'menu')}
        onClosed={() => {
          const run = afterPrompt.current;
          afterPrompt.current = null;
          run?.();
        }}
      />
      {next && (
        <DubSheet
          visible={nextAsk && !!nextWarnTitle}
          title={nextWarnTitle ?? ''}
          message={`Cet épisode n’existe pas en ${dubName(dub.lang)} dans tes sources.`}
          fallback={nextFallback}
          onFallback={acceptNext}
          onBack={() => setNextAsk(false)}
          backLabel="Annuler"
          onClose={() => setNextAsk(false)}
        />
      )}
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
      {next && <PrefetchNext seriesId={series.id} episode={next.number} armed={prefetchArmed} buffer={prewarmNext} onDub={setNextDub} />}
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

/** True when the last accepted tap was less than a second ago; otherwise records this one. */
function tappedRecently(last: { current: number }) {
  const now = Date.now();
  if (now - last.current < 1000) return true;
  last.current = now;
  return false;
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
