// Huwa video player: expo-video (or libmpv for what it cannot play, see ./engines) + custom controls.
// - external subtitles (ASS/SSA, SRT, WebVTT) drawn by ./subtitles (expo-video has no sidecar subtitle API)
// - embedded audio / subtitle tracks (player.audioTrack / player.subtitleTrack), speed; a dubbed
//   source starts on the dub language's audio track (`audioLangs`, MULTI files often default to
//   Japanese) with only forced subtitles (signs / songs) in that language
// - AniSkip opening / ending / recap segments: skip buttons during the segment, markers on the bar,
//   "Épisode suivant" during the ending + cancellable countdown (fallbacks: +85 s, last 90 s)
// - landscape: rotating the phone (or the button) goes fullscreen; double-tap ±10 s, vertical drag
//   = brightness (left) / volume (right), screen lock, comments panel over the video, live comments
// - PiP, AirPlay, resume position (`startAt`), progress saved every 5 s (`onProgress`)
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEvent, useEventListener } from 'expo';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import {
  isPictureInPictureSupported,
  VideoAirPlayButton,
  type AudioTrack,
  type SubtitleTrack,
  type VideoView,
} from 'expo-video';
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { ActivityIndicator, BackHandler, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInLeft, SlideInRight, SlideOutLeft, SlideOutRight } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { traceInfo, traceMark } from '@/addons/timing';
import { Txt, type IconName } from '@/components/ui';
import { usePlayerTrace } from '@/stats/use-player-trace';
import { C, F, R, S } from '@/theme/tokens';

import { useSkipTimes, type Segment } from './aniskip';
import { SourceLoadingBar, type LoadPhase } from './SourceLoadingBar';
import { EngineView, useEnginePlayer, type EnginePlayer as VideoPlayer } from './engines';
import { pickAudioTrack } from './engines/tracks';
import { useMpvSubtitles } from './engines/use-mpv-subtitles';
import { GestureLayer, type Hud } from './GestureLayer';
import { AUTO_NEXT_SECONDS, NextCard, Pill, type NextInfo } from './overlays';
import { PlayerSettings, type Option } from './PlayerSettings';
import type { PlaybackMonitor } from './playback-monitor';
import { useSeamlessUpgrade, type UpgradeRequest } from './seamless-upgrade';
import { usePlaybackMonitor } from './use-playback-monitor';
import { getPrefs, setPrefs, usePrefs } from './prefs';
import { formatTime, SeekBar } from './SeekBar';
import { SubtitleOverlay, SubtitleSheet, useSubtitleController, type ExternalSubtitle } from './subtitles';
import { takeWarm } from './warm-pool';

export type { ExternalSubtitle } from './subtitles';

export type PlayerSource = { uri: string; headers?: Record<string, string> };

export type PlayerHandle = {
  getTime: () => number;
  seekTo: (seconds: number) => void;
  play: () => void;
  pause: () => void;
  /** Stops what plays now (audio and picture), e.g. right before leaving for the next episode. */
  stop: () => void;
};

/** `timestamp`: start; `end`: end of a range (shown while the playhead is inside it). Text is plain. */
export type TimedComment = { id: string; author: string; text: string; timestamp: number; end?: number };

export type PlayerProps = {
  ref?: Ref<PlayerHandle>;
  source?: PlayerSource | null;
  title: string;
  subtitle?: string;
  artwork?: string;
  /** External subtitle files (ASS/SSA, SRT, WebVTT; gzip and legacy encodings handled). */
  subtitles?: ExternalSubtitle[];
  /** Stable id of what is playing (episode id): the subtitle sync offset is remembered per id. */
  mediaKey?: string;
  /**
   * Languages that have a full subtitle track for what plays: external files, tracks embedded in
   * the video (known once it is loaded) and an on-device translation. Changes only.
   */
  onSubtitleLangs?: (langs: string[]) => void;
  /** Resume position in seconds, read when the first source finishes loading. */
  startAt?: () => number | undefined;
  /** Throttled (5 s) and on leave. */
  onProgress?: (position: number, duration: number) => void;
  onEnd?: () => void;
  /** Playback failed on the current source (the parent can try another one). */
  onError?: (message: string) => void;
  /** `warning`: the next episode lacks the user's dub, the card asks instead of counting down. */
  next?: NextInfo | null;
  /** MyAnimeList id + episode number → AniSkip timestamps. */
  malId?: number | null;
  episodeNumber?: number;
  /** Text shown when there is no source yet. */
  emptyText?: string;
  /** Bold line above `emptyText` (why nothing plays). */
  emptyTitle?: string;
  /** One-tap fix under `emptyText` ("Activer le moteur torrent", "Réessayer"…). */
  emptyAction?: { label: string; onPress: () => void } | null;
  /**
   * Where the source search stands before anything plays (drives the loading bar): `search` =
   * addons still answering (`answered` 0..1), `race` = links being tested / torrent resolved,
   * null = nothing more is coming (the bar fades out, `emptyText` shows).
   */
  sourceSearch?: { phase: 'search' | 'race' | 'peers' | null; answered: number };
  /** Short message over the video (e.g. "better quality found"). */
  notice?: string;
  /** The parent should hide everything else and give the player the whole screen while `true`. */
  onFullscreenChange?: (full: boolean) => void;
  /** Sources menu, reachable from the fullscreen controls. */
  onOpenSources?: () => void;
  sourceLabel?: string;
  /** Content of the landscape comments panel. */
  renderComments?: () => ReactNode;
  commentCount?: number;
  /** Time-anchored comments shown over the video when their moment comes. */
  timedComments?: TimedComment[];
  /**
   * Source to switch to without stopping (warmed in a hidden player, swapped when ready), from
   * the source controller. `onUpgraded` then expects the parent to pass it as `source` (it is not
   * reloaded).
   */
  upgrade?: UpgradeRequest | null;
  onUpgraded?: (key: string) => void;
  /** The switch could not be seamless (other engine, stalled, other cut…): playback was not touched. */
  onUpgradeDeferred?: (key: string, reason: string) => void;
  /** Observes the playing source for the source controller (stalls, buffer, peers). */
  monitor?: PlaybackMonitor;
  /** "Lecture" sheet: what plays ("AIOStreams · 1080p · HTTP") and the last automatic change. */
  sourceInfo?: { label: string; detail?: string };
  /**
   * The source is dubbed: its audio track in the first of these languages is selected when it
   * loads (tag first, then the track title "VF" / "Français"), and only forced subtitles in these
   * languages are shown by default. Null / empty: the file's default track, full subtitles.
   */
  audioLangs?: string[] | null;
  /** Audio tracks of the loaded file (the source's real languages), per source URI. */
  onAudioTracks?: (uri: string, tracks: AudioTrack[]) => void;
};

const NEXT_WINDOW = 90;
const LIVE_COMMENT_SECONDS = 7;
const hitSlop = 10;

function Ctl({ icon, label, onPress, size = 22, big, active }: { icon: IconName; label: string; onPress: () => void; size?: number; big?: boolean; active?: boolean }) {
  const d = big ? 76 : 44;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={active !== undefined ? { selected: active } : undefined}
      style={({ pressed }) => [
        { width: d, height: d, borderRadius: d / 2, alignItems: 'center', justifyContent: 'center' },
        big && styles.bigCtl,
        active && { backgroundColor: C.accentSoft },
        pressed && { opacity: 0.7, transform: [{ scale: 0.92 }] },
      ]}>
      <Ionicons name={icon} size={big ? 36 : size} color={active ? C.accentText : C.white} style={[styles.glyphShadow, big && icon === 'play' ? { marginLeft: 4 } : null]} />
    </Pressable>
  );
}

/** ±10 s: a circular arrow with the seconds inside (Netflix / Apple TV glyph). */
function SkipCtl({ dir, label, onPress }: { dir: -1 | 1; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={hitSlop} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => [styles.skip, pressed && { opacity: 0.7, transform: [{ scale: 0.9 }] }]}>
      <Ionicons name="refresh" size={42} color={C.white} style={[styles.glyphShadow, dir < 0 && { transform: [{ scaleX: -1 }] }]} />
      <Text style={styles.skipText} allowFontScaling={false}>10</Text>
    </Pressable>
  );
}

/** Imperative player writes (kept out of render so the React Compiler treats `player` as opaque). */
function setProp<K extends 'currentTime' | 'playbackRate' | 'subtitleTrack' | 'audioTrack' | 'volume'>(p: VideoPlayer, k: K, v: VideoPlayer[K]) {
  p[k] = v;
}

const lockOrientation = (lock: ScreenOrientation.OrientationLock) => ScreenOrientation.lockAsync(lock).catch(() => {});

export function Player({
  ref,
  source,
  title,
  subtitle,
  artwork,
  subtitles = [],
  mediaKey,
  onSubtitleLangs,
  startAt,
  onProgress,
  onEnd,
  onError,
  next,
  malId,
  episodeNumber = 1,
  emptyText = 'Choisis une source pour lancer la lecture.',
  emptyTitle,
  emptyAction,
  sourceSearch,
  notice,
  onFullscreenChange,
  onOpenSources,
  sourceLabel,
  renderComments,
  commentCount,
  timedComments = [],
  upgrade,
  onUpgraded,
  onUpgradeDeferred,
  monitor,
  sourceInfo,
  audioLangs,
  onAudioTracks,
}: PlayerProps) {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const prefs = usePrefs();
  const view = useRef<VideoView>(null);
  const lastSave = useRef(0);
  const loadedOnce = useRef(false);
  const cb = useRef({ startAt, onProgress, onEnd, onError, next, onFullscreenChange, audioLangs, onAudioTracks });
  const lastPos = useRef({ t: 0, d: 0 });
  useEffect(() => {
    cb.current = { startAt, onProgress, onEnd, onError, next, onFullscreenChange, audioLangs, onAudioTracks };
  });
  /** URI of the current source, for the track handlers (events arrive after the render). */
  const sourceUri = useRef<string | null>(null);
  useEffect(() => {
    sourceUri.current = source?.uri ?? null;
  }, [source?.uri]);

  const player = useEnginePlayer(null, (p) => {
    p.timeUpdateEventInterval = 0.25;
    p.allowsExternalPlayback = true;
    p.showNowPlayingNotification = true;
  });

  const [time, setTime] = useState({ t: 0, buffered: 0 });
  const [duration, setDuration] = useState(0);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [audioTrack, setAudioTrack] = useState<AudioTrack | null>(null);
  const [embedded, setEmbedded] = useState<SubtitleTrack[]>([]);
  const [aspect, setAspect] = useState<number | undefined>();
  const [subSheet, setSubSheet] = useState(false);
  const [controls, setControls] = useState(true);
  const [touch, setTouch] = useState(0);
  const [settings, setSettings] = useState(false);
  const subsAfterSettings = useRef(false);
  const [locked, setLocked] = useState(false);
  const [unlockHint, setUnlockHint] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [hud, setHud] = useState<Hud | null>(null);
  // Pinch zoom (fullscreen): fill the screen, cropping the picture's edges, or show it whole.
  const [fill, setFill] = useState(false);
  const [zoomNote, setZoomNote] = useState<string | null>(null);
  const onPinch = (next: boolean) => {
    setFill(next);
    setZoomNote(next ? 'Zoom : plein écran' : 'Image entière');
  };
  useEffect(() => {
    if (!zoomNote) return;
    const id = setTimeout(() => setZoomNote(null), 1200);
    return () => clearTimeout(id);
  }, [zoomNote]);
  const [flash, setFlash] = useState<{ side: 'left' | 'right'; n: number } | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [ended, setEnded] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);

  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  usePlayerTrace(player, mediaKey, source?.uri);
  const { status, error } = useEvent(player, 'statusChange', { status: player.status, error: undefined });

  // ---------- fullscreen = landscape ----------
  const full = window.width > window.height;
  // Zoom only applies in fullscreen; the inline 16:9 frame always shows the whole picture.
  const zoomed = fill && full;
  useEffect(() => {
    player.setFill(zoomed);
  }, [player, zoomed]);
  useEffect(() => {
    cb.current.onFullscreenChange?.(full);
  }, [full]);
  useEffect(() => {
    // Rotation is allowed on this screen only; portrait again when leaving.
    lockOrientation(ScreenOrientation.OrientationLock.DEFAULT);
    return () => {
      lockOrientation(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    };
  }, []);
  const enterFull = () => lockOrientation(ScreenOrientation.OrientationLock.LANDSCAPE);
  // Leaving with the button pins portrait (the phone may still be held sideways).
  const exitFull = () => {
    setCommentsOpen(false);
    setLocked(false);
    lockOrientation(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  };
  useEffect(() => {
    if (!full) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      exitFull();
      return true;
    });
    return () => sub.remove();
  }, [full]);

  // ---------- source & resume ----------
  // When the current source started playing (seamless upgrade: no swap in the first seconds).
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // URI already playing after a seamless upgrade: the parent passes it next, nothing to reload.
  const adopted = useRef<string | null>(null);
  const headersKey = JSON.stringify(source?.headers ?? {});
  const hadSource = useRef(false);
  useEffect(() => {
    if (!source?.uri) {
      // The source went away (another one is being resolved, none left): the old one stops now
      // instead of playing on under the next one.
      if (hadSource.current) player.stop();
      hadSource.current = false;
      adopted.current = null;
      return;
    }
    hadSource.current = true;
    if (adopted.current === source.uri) {
      adopted.current = null;
      return;
    }
    adopted.current = null;
    setStartedAt(null);
    monitor?.reset(source.uri);
    let alive = true;
    // Switching source mid-episode (quality upgrade, fallback, manual pick) keeps the position.
    const keep = loadedOnce.current ? player.currentTime : undefined;
    const src = { uri: source.uri, headers: source.headers, metadata: { title, artist: subtitle, artwork } };
    // Opened ahead by the pre-search / next-episode prefetch: take that player over (no reload).
    const warm = takeWarm(source.uri, source.headers);
    let tookWarm = false;
    if (warm) {
      tookWarm = player.adoptWarm(warm, src);
      if (!tookWarm) setTimeout(() => warm.release(), 0);
    }
    if (mediaKey) traceInfo(mediaKey, { warm: tookWarm });
    if (mediaKey) traceMark(mediaKey, 'url', tookWarm ? 'lecteur préchauffé' : undefined);
    // Resume position, known before the load: mpv opens the file right there (see replaceAsync).
    const at = keep != null && keep > 1 ? keep : cb.current.startAt?.();
    (tookWarm ? Promise.resolve() : player.replaceAsync(src, { startAt: at }))
      .then(() => {
        if (!alive) return;
        if (tookWarm) {
          // A warm player already waits at the resume position (else: where it should be).
          const want = at && at > 1 ? at : 0;
          if (Math.abs(player.currentTime - want) > 2) setProp(player, 'currentTime', want);
        } else if (at && at > 1) setProp(player, 'currentTime', at);
        loadedOnce.current = true;
        setEnded(false);
        setCountdown(null);
        setStartedAt(Date.now());
        player.play();
      })
      .catch((e: unknown) => {
        // A failure of the previous source must not mark the new one bad.
        if (alive) cb.current.onError?.(e instanceof Error ? e.message : 'Lecture impossible');
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.uri, headersKey, player]);

  // ---------- seamless quality upgrade ----------
  const [pip, setPip] = useState(false);
  usePlaybackMonitor(player, monitor, source?.uri, pip);
  useSeamlessUpgrade(player, source?.uri ? upgrade : null, {
    external: pip,
    startedAt,
    onSwapped: (key, uri) => {
      adopted.current = uri;
      setStartedAt(Date.now());
      monitor?.adopt(uri);
      onUpgraded?.(key);
    },
    onDeferred: (key, reason) => onUpgradeDeferred?.(key, reason),
  });

  // ---------- audio track of a dubbed source ----------
  // Once per source: the track in the dub language (a manual pick in the settings sheet stays).
  const audioPicked = useRef<string | null>(null);
  const onTracks = (tracks: AudioTrack[]) => {
    const uri = sourceUri.current;
    if (!uri) return;
    if (tracks.length) cb.current.onAudioTracks?.(uri, tracks);
    const langs = cb.current.audioLangs;
    if (!langs?.length || tracks.length < 1 || audioPicked.current === uri) return;
    const i = pickAudioTrack(tracks, langs);
    if (i < 0) return;
    audioPicked.current = uri;
    const want = tracks[i];
    const cur = player.audioTrack;
    if (!cur || cur.id !== want.id || cur.language !== want.language || cur.label !== want.label) setProp(player, 'audioTrack', want);
  };
  const onTracksRef = useRef(onTracks);
  useEffect(() => {
    onTracksRef.current = onTracks;
  });
  // The source became dubbed after it loaded (a track check, the user's choice): pick now.
  const dubAudioKey = (audioLangs ?? []).join(',');
  useEffect(() => {
    if (dubAudioKey) onTracksRef.current(player.availableAudioTracks);
  }, [dubAudioKey, player]);

  useEventListener(player, 'sourceLoad', (e) => {
    setDuration(e.duration);
    setAudioTracks(e.availableAudioTracks);
    onTracks(e.availableAudioTracks);
    setEmbedded(e.availableSubtitleTracks);
    setAudioTrack(player.audioTrack);
    const size = (player.videoTrack ?? e.availableVideoTracks[0])?.size;
    setAspect(size && size.width > 0 && size.height > 0 ? size.width / size.height : undefined);
  });
  useEventListener(player, 'videoTrackChange', ({ videoTrack }) => {
    if (videoTrack?.size.width && videoTrack.size.height) setAspect(videoTrack.size.width / videoTrack.size.height);
  });
  useEventListener(player, 'statusChange', ({ status: s, error: err }) => {
    if (s === 'readyToPlay' && isFinite(player.duration)) setDuration(player.duration);
    if (s === 'error') cb.current.onError?.(err?.message ?? 'Lecture impossible');
  });
  useEventListener(player, 'availableAudioTracksChange', (e) => {
    setAudioTracks(e.availableAudioTracks);
    onTracks(e.availableAudioTracks);
  });
  useEventListener(player, 'availableSubtitleTracksChange', (e) => setEmbedded(e.availableSubtitleTracks));
  useEventListener(player, 'audioTrackChange', (e) => setAudioTrack(e.audioTrack));

  // ---------- AniSkip segments ----------
  const { segments } = useSkipTimes(malId, episodeNumber, duration);
  const intro = segments.find((s) => s.kind === 'intro');
  const outro = segments.find((s) => s.kind === 'outro');
  const segRef = useRef<{ outro?: Segment; countdownFired: boolean }>({ countdownFired: false });
  useEffect(() => {
    segRef.current.outro = outro;
  }, [outro]);
  // New source / episode: the auto-next countdown may run again.
  useEffect(() => {
    segRef.current.countdownFired = false;
  }, [source?.uri]);

  useEventListener(player, 'timeUpdate', ({ currentTime, bufferedPosition }) => {
    setTime({ t: currentTime, buffered: bufferedPosition });
    lastPos.current = { t: currentTime, d: player.duration || lastPos.current.d };
    // The ending started: offer the next episode with a cancellable countdown (once per pass:
    // seeking back before the ending re-arms it).
    const o = segRef.current.outro;
    const armAt = o ? o.start : (player.duration || Infinity) - 30;
    if (segRef.current.countdownFired && currentTime < armAt - 5) segRef.current.countdownFired = false;
    if (o && !segRef.current.countdownFired && currentTime >= o.start && currentTime < o.end && cb.current.next && getPrefs().autoNext) {
      segRef.current.countdownFired = true;
      setCountdown(AUTO_NEXT_SECONDS);
      setControls(false);
    }
    if (Date.now() - lastSave.current < 5000) return;
    lastSave.current = Date.now();
    cb.current.onProgress?.(currentTime, player.duration);
  });

  useEventListener(player, 'playToEnd', () => {
    setEnded(true);
    setControls(true);
    cb.current.onEnd?.();
    if (cb.current.next && getPrefs().autoNext && !segRef.current.countdownFired) {
      segRef.current.countdownFired = true;
      setCountdown(AUTO_NEXT_SECONDS);
    }
  });

  // Save on leave. The native player is released by its own hook cleanup before this one runs,
  // so the position comes from the last time update, not from the (already gone) player.
  useEffect(
    () => () => {
      const { t: at, d } = lastPos.current;
      if (at > 0 && d > 0) cb.current.onProgress?.(at, d);
    },
    [player],
  );

  // ---------- auto next ----------
  // Pill, countdown card and the end of the countdown can all fire, taps can repeat: one call per
  // second at most. This episode stops right away, before the navigation, so it is never heard
  // under the next one.
  const lastNext = useRef(0);
  const playNext = () => {
    if (!cb.current.next || Date.now() - lastNext.current < 1000) return;
    // Not in the user's language: the card asks first (no silent switch).
    if (cb.current.next.warning) {
      setCountdown(AUTO_NEXT_SECONDS);
      return;
    }
    lastNext.current = Date.now();
    setCountdown(null);
    player.stop();
    cb.current.next.onPlay();
  };
  const playNextRef = useRef(playNext);
  useEffect(() => {
    playNextRef.current = playNext;
  });
  const nextWarned = !!next?.warning;
  useEffect(() => {
    // A warning card waits for the user's answer: no countdown.
    if (countdown === null || nextWarned) return;
    if (countdown <= 0) {
      playNextRef.current();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, nextWarned]);

  // ---------- speed ----------
  useEffect(() => {
    setProp(player, 'playbackRate', prefs.rate);
  }, [player, prefs.rate]);

  // ---------- subtitles ----------
  const subs = useSubtitleController({ external: subtitles, embedded, mediaKey, time: time.t, dubLangs: audioLangs?.length ? audioLangs : null });
  const subLangsKey = subs.fullLangs.join(',');
  const onSubLangsRef = useRef(onSubtitleLangs);
  useEffect(() => {
    onSubLangsRef.current = onSubtitleLangs;
  });
  useEffect(() => {
    onSubLangsRef.current?.(subLangsKey ? subLangsKey.split(',') : []);
  }, [subLangsKey, source?.uri]);
  // mpv engine: the user's look on the tracks it draws; styled ASS files drawn by libass.
  const libass = useMpvSubtitles(player, subs.doc, subs.docText, subs.selected?.lang ?? 'und', subs.offset);
  const shownNotice = notice || subs.badge || undefined;
  const embIndex = subs.embeddedIndex;
  useEffect(() => {
    try {
      setProp(player, 'subtitleTrack', embedded[embIndex] ?? null);
    } catch {
      // not supported on this platform
    }
  }, [player, embedded, embIndex]);

  const audioOptions: Option[] = audioTracks.map((a, i) => ({ key: String(i), label: a.label || a.name || a.language, hint: a.language?.toUpperCase() }));
  const audioKey = String(Math.max(0, audioTracks.findIndex((a) => (a.id && a.id === audioTrack?.id) || (a.label === audioTrack?.label && a.language === audioTrack?.language))));

  // ---------- controls visibility ----------
  const wake = () => {
    setControls(true);
    setTouch((n) => n + 1);
  };
  useEffect(() => {
    if (!controls || !isPlaying || settings) return;
    const t = setTimeout(() => setControls(false), 4000);
    return () => clearTimeout(t);
  }, [controls, isPlaying, settings, touch]);
  useEffect(() => {
    if (!unlockHint) return;
    const t = setTimeout(() => setUnlockHint(false), 2500);
    return () => clearTimeout(t);
  }, [unlockHint]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 650);
    return () => clearTimeout(t);
  }, [flash]);

  // ---------- actions ----------
  const seekTo = (t: number) => {
    monitor?.noteSeek();
    const d = player.duration;
    setProp(player, 'currentTime', Math.max(0, isFinite(d) && d > 0 ? Math.min(t, d - 0.5) : t));
    setTime((s) => ({ ...s, t: player.currentTime }));
    if (ended) {
      setEnded(false);
      setCountdown(null);
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      getTime: () => player.currentTime,
      seekTo: (t) => {
        monitor?.noteSeek();
        setProp(player, 'currentTime', Math.max(0, t));
        player.play();
      },
      play: () => player.play(),
      pause: () => player.pause(),
      stop: () => player.stop(),
    }),
    [player, monitor],
  );

  const onTap = () => {
    if (locked) return setUnlockHint(true);
    if (controls) setControls(false);
    else wake();
  };
  const onDoubleTap = (side: 'left' | 'right') => {
    seekTo(time.t + (side === 'left' ? -10 : 10));
    setFlash((f) => ({ side, n: f?.side === side ? f.n + 1 : 1 }));
  };

  // ---------- skip buttons ----------
  const t = time.t;
  const inSeg = (s?: Segment) => !!s && t >= s.start && t < s.end - 1;
  const recap = segments.find((s) => s.kind === 'recap');
  const skipBtn: { key: string; label: string; to: number } | null = (() => {
    if (ended) return null;
    if (intro && inSeg(intro) && !skipped.includes('intro')) return { key: 'intro', label: 'Passer l’intro', to: intro.end };
    if (recap && inSeg(recap) && !skipped.includes('recap')) return { key: 'recap', label: 'Passer le récap', to: recap.end };
    if (outro && inSeg(outro) && !skipped.includes('outro') && outro.end < duration - 3) return { key: 'outro', label: 'Passer le générique', to: outro.end };
    return null;
  })();
  // A skip button shows on its own for 5 s, then only with the controls (it stays usable).
  const skipId = skipBtn ? `${skipBtn.key}:${skipBtn.label}` : '';
  const [skipSeen, setSkipSeen] = useState<{ id: string; at: number } | null>(null);
  // New button, or the user seeked back before it first appeared: start the 5 s again
  // (state adjusted during render, React's "derive from changing input" pattern).
  if (skipId && (skipSeen?.id !== skipId || t < skipSeen.at - 1)) setSkipSeen({ id: skipId, at: t });
  const skipVisible = !!skipBtn && (controls || (skipSeen?.id === skipId && t - skipSeen.at < 5));
  const showNext = !!next && !ended && countdown === null && duration > 60 && (outro ? t >= outro.start : duration - t <= NEXT_WINDOW);
  const markers = segments.filter((s) => s.kind !== 'recap');
  const commentMarks = useMemo(() => timedComments.map((c) => ({ start: c.timestamp, end: c.end })), [timedComments]);

  // ---------- live comments ----------
  const live = full && prefs.liveComments && !commentsOpen
    ? timedComments.filter((c) => t >= c.timestamp && t < Math.max(c.end ?? 0, c.timestamp + LIVE_COMMENT_SECONDS)).slice(-3)
    : [];

  // ---------- subtitles only over a picture ----------
  // Before the current file's first frame (loading, a source that never shows), cues timed from 0
  // would read as nonsense over a black screen: subtitles wait for a picture of this source.
  const uri = source?.uri ?? null;
  const uriRef = useRef(uri);
  useEffect(() => {
    uriRef.current = uri;
  }, [uri]);
  const [frameFor, setFrameFor] = useState<string | null>(null);
  useEffect(() => player.onMpvFirstFrame(() => setFrameFor(uriRef.current)), [player]);
  // A handed-over source (warm hidden player) may have drawn its first frame before it became
  // current: playback moving on it counts as a picture too.
  if (uri && frameFor !== uri && isPlaying && time.t > 0.2 && status === 'readyToPlay') setFrameFor(uri);
  const hasPicture = !!uri && frameFor === uri;

  const pipOk = Platform.OS !== 'web' && isPictureInPictureSupported();
  const loading = !!source?.uri && (status === 'loading' || (status === 'idle' && !ended));

  // ---------- loading bar: from the source search until the first frame is ready ----------
  // Once something played (upgrades, next source after a failure) the usual spinner is enough.
  const [everReady, setEverReady] = useState(false);
  if (!everReady && !!source?.uri && (status === 'readyToPlay' || isPlaying)) setEverReady(true);
  const [barGone, setBarGone] = useState(false);
  const barPhase: LoadPhase | null = everReady
    ? 'ready'
    : source?.uri
      ? status === 'error' ? null : 'connect'
      : sourceSearch?.phase ?? null;
  // A new search signal after giving up (e.g. a link that was still being checked): show it again.
  if (barGone && !everReady && barPhase && sourceSearch) setBarGone(false);
  const barShown = !!sourceSearch && !barGone && status !== 'error';
  const remaining = duration - t;
  const sideInset = full ? Math.max(insets.left, insets.right, S.lg) : S.md;
  const panelW = Math.min(420, window.width * 0.42);
  const panelLeft = prefs.commentsSide === 'left';
  const bottomOffset = controls ? (full ? 76 + Math.max(insets.bottom - 8, 0) : 52) : full ? 24 : 12;

  return (
    <View style={full ? styles.full : styles.inline}>
      {full && <StatusBar hidden animated />}
      <EngineView
        ref={view}
        player={player}
        style={StyleSheet.absoluteFill}
        nativeControls={false}
        contentFit={zoomed ? 'cover' : 'contain'}
        allowsPictureInPicture
        startsPictureInPictureAutomatically
        onFirstFrameRender={() => {
          setFrameFor(uriRef.current);
          if (mediaKey) traceMark(mediaKey, 'first-frame');
          monitor?.firstFrame();
        }}
        onPictureInPictureStart={() => setPip(true)}
        onPictureInPictureStop={() => setPip(false)}
      />

      <GestureLayer
        width={window.width}
        height={full ? window.height : (window.width * 9) / 16}
        adjust={full && !locked && !settings}
        seekEnabled={!locked && duration > 0}
        onTap={onTap}
        onDoubleTap={onDoubleTap}
        getVolume={() => player.volume}
        setVolume={(v) => setProp(player, 'volume', v)}
        onHud={setHud}
        onPinch={full ? onPinch : undefined}
      />

      {!pip && hasPicture && (
        <SubtitleOverlay
          doc={libass ? null : subs.doc}
          time={time.t}
          playing={isPlaying}
          rate={prefs.rate}
          offset={subs.offset}
          aspect={aspect}
          fill={zoomed}
          reserveBottom={controls && !locked ? bottomOffset + 8 : 0}
          reserveTop={controls && !locked ? (full ? Math.max(insets.top, S.md) : 0) + 48 : 0}
          insets={full ? insets : undefined}
        />
      )}

      {barShown && (
        <SourceLoadingBar phase={barPhase} answered={sourceSearch?.answered} onGone={() => setBarGone(true)} />
      )}
      {!source?.uri && !barShown && (
        <View pointerEvents="box-none" style={styles.center}>
          <Ionicons name={emptyTitle ? 'alert-circle-outline' : 'play-circle-outline'} size={36} color={C.text2} />
          {!!emptyTitle && <Txt v="label">{emptyTitle}</Txt>}
          <Txt v="small" style={{ textAlign: 'center', paddingHorizontal: S.xl }}>{emptyText}</Txt>
          {!!emptyAction && (
            <Pressable
              onPress={emptyAction.onPress}
              accessibilityRole="button"
              hitSlop={hitSlop}
              style={({ pressed }) => [styles.emptyAction, pressed && { opacity: 0.7 }]}>
              <Text style={styles.emptyActionText}>{emptyAction.label}</Text>
            </Pressable>
          )}
        </View>
      )}
      {status === 'error' && (
        <View pointerEvents="none" style={styles.center}>
          <Ionicons name="alert-circle-outline" size={32} color={C.text} />
          <Txt v="label">Lecture impossible</Txt>
          {!!error?.message && <Txt v="small" numberOfLines={2} style={{ textAlign: 'center', paddingHorizontal: S.xl }}>{error.message}</Txt>}
        </View>
      )}

      {/* Double-tap feedback */}
      {flash && (
        <Animated.View entering={FadeIn.duration(90)} exiting={FadeOut.duration(200)} pointerEvents="none"
          style={[styles.flash, flash.side === 'left' ? { left: 0, borderTopRightRadius: 999, borderBottomRightRadius: 999 } : { right: 0, borderTopLeftRadius: 999, borderBottomLeftRadius: 999 }]}>
          <Ionicons name={flash.side === 'left' ? 'play-back' : 'play-forward'} size={26} color={C.white} />
          <Text style={styles.flashText}>{flash.side === 'left' ? '-' : '+'}{10 * flash.n} s</Text>
        </Animated.View>
      )}

      {/* Brightness / volume indicator */}
      {hud && (
        <View pointerEvents="none" style={styles.hud}>
          <Ionicons
            name={hud.kind === 'brightness' ? 'sunny' : hud.value === 0 ? 'volume-mute' : hud.value < 0.5 ? 'volume-low' : 'volume-high'}
            size={20}
            color={C.white}
          />
          <View style={styles.hudTrack}>
            <View style={[styles.hudFill, { width: `${Math.round(hud.value * 100)}%` }]} />
          </View>
          <Text style={styles.hudText}>{Math.round(hud.value * 100)}</Text>
        </View>
      )}

      {!!zoomNote && (
        <View pointerEvents="none" style={[styles.notice, { top: full ? S.lg : S.sm }]}>
          <Txt v="small" color={C.white}>{zoomNote}</Txt>
        </View>
      )}
      {!!shownNotice && !zoomNote && (
        <View pointerEvents="none" style={[styles.notice, { top: full ? S.lg : S.sm }]} accessibilityLiveRegion="polite">
          <Txt v="small" color={C.white}>{shownNotice}</Txt>
        </View>
      )}

      {/* Live time-anchored comments */}
      {live.length > 0 && (
        <View pointerEvents="none" style={[styles.live, { bottom: bottomOffset + 8 }, panelLeft ? { right: sideInset } : { left: sideInset }]}>
          {live.map((c) => (
            <Animated.View key={c.id} entering={FadeIn.duration(220)} exiting={FadeOut.duration(220)} style={styles.liveRow}>
              <Text style={styles.liveAuthor}>{c.author}{c.end !== undefined ? `  ·  ${formatTime(c.timestamp)}–${formatTime(c.end)}` : ''}</Text>
              <Text style={styles.liveText} numberOfLines={2}>{c.text}</Text>
            </Animated.View>
          ))}
        </View>
      )}

      {locked ? (
        unlockHint && (
          <View pointerEvents="box-none" style={styles.center}>
            <Pressable onPress={() => { setLocked(false); wake(); }} style={styles.unlock} accessibilityRole="button" accessibilityLabel="Déverrouiller l’écran">
              <Ionicons name="lock-open" size={18} color={C.bg} />
              <Text style={styles.pillText}>Déverrouiller</Text>
            </Pressable>
          </View>
        )
      ) : controls ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {/* Scrims instead of a flat dim: the picture stays bright in the middle. */}
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.22)' }]} />
          <LinearGradient pointerEvents="none" colors={['rgba(0,0,0,0.72)', 'rgba(0,0,0,0)']} style={[styles.scrimTop, { height: full ? 150 : 90 }]} />
          <LinearGradient pointerEvents="none" colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.78)']} style={[styles.scrimBottom, { height: full ? 170 : 96 }]} />

          <View pointerEvents="box-none" style={[styles.topRow, full && { paddingTop: Math.max(insets.top, S.md), paddingHorizontal: sideInset }]}>
            {full ? (
              <>
                <Ctl icon="chevron-down" label="Quitter le plein écran" onPress={exitFull} />
                <View style={{ flex: 1, gap: 1, paddingLeft: 4 }}>
                  <Txt v="headline" numberOfLines={1} style={styles.titleShadow}>{title}</Txt>
                  {!!subtitle && <Txt v="footnote" color="rgba(255,255,255,0.75)" numberOfLines={1} style={styles.titleShadow}>{subtitle}</Txt>}
                </View>
                {onOpenSources && (
                  <Pressable onPress={onOpenSources} style={styles.chipBtn} accessibilityRole="button" accessibilityLabel="Sources">
                    <Ionicons name="layers-outline" size={16} color={C.white} />
                    <Text style={styles.chipText} numberOfLines={1}>{sourceLabel ?? 'Sources'}</Text>
                  </Pressable>
                )}
                {renderComments && (
                  <Pressable onPress={() => { setCommentsOpen((o) => !o); wake(); }} style={[styles.chipBtn, commentsOpen && { backgroundColor: C.accentSoft }]}
                    accessibilityRole="button" accessibilityLabel="Commentaires">
                    <Ionicons name="chatbubbles-outline" size={16} color={C.white} />
                    {commentCount != null && <Text style={styles.chipText}>{commentCount}</Text>}
                  </Pressable>
                )}
                <Ctl icon="lock-closed-outline" label="Verrouiller l’écran" onPress={() => { setLocked(true); setControls(false); setCommentsOpen(false); }} />
              </>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            {Platform.OS === 'ios' && (
              <View style={styles.airplay} accessibilityLabel="AirPlay">
                <VideoAirPlayButton tint={C.white} activeTint={C.accentText} prioritizeVideoDevices style={{ width: 26, height: 26 }} />
              </View>
            )}
            <Ctl icon="text" label="Sous-titres" active={subs.selectedKey !== 'off'} onPress={() => { if (!settings) setSubSheet(true); wake(); }} size={20} />
            {pipOk && <Ctl icon="albums-outline" label="Image dans l’image" onPress={() => view.current?.startPictureInPicture().catch(() => {})} />}
            <Ctl icon="settings-outline" label="Réglages de lecture" onPress={() => { if (!subSheet) { subsAfterSettings.current = false; setSettings(true); } wake(); }} />
          </View>

          {/* Hidden while sources are searched and when nothing can play: the explanation and its
              one-tap fix ("Activer le moteur torrent") sit in the middle of the frame. */}
          <View pointerEvents={(barShown && !everReady) || !source?.uri ? 'none' : 'box-none'}
            style={[styles.middle, full && { gap: 72 }, ((barShown && !everReady) || !source?.uri) && { opacity: 0 }]}>
            <SkipCtl dir={-1} label="Reculer de 10 secondes" onPress={() => { seekTo(t - 10); wake(); }} />
            {loading ? (
              <View style={{ width: 76, height: 76, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={C.white} size="large" /></View>
            ) : ended ? (
              <Ctl big icon="refresh" label="Revoir" onPress={() => { seekTo(0); player.play(); wake(); }} />
            ) : (
              <Ctl big icon={isPlaying ? 'pause' : 'play'} label={isPlaying ? 'Pause' : 'Lecture'}
                onPress={() => { if (isPlaying) player.pause(); else player.play(); wake(); }} />
            )}
            <SkipCtl dir={1} label="Avancer de 10 secondes" onPress={() => { seekTo(t + 10); wake(); }} />
          </View>

          <View pointerEvents="box-none" style={[styles.bottomRow, full && { paddingBottom: Math.max(insets.bottom, S.md), paddingHorizontal: sideInset }]}>
            <Text style={styles.time}>{formatTime(t)}</Text>
            <SeekBar position={t} duration={duration} buffered={time.buffered} markers={markers} commentMarks={prefs.liveComments ? commentMarks : undefined} onScrubStart={wake} onSeek={(x) => { seekTo(x); wake(); }} />
            <Text style={styles.time}>{duration > 0 ? `-${formatTime(Math.max(0, remaining))}` : '--:--'}</Text>
            {prefs.rate !== 1 && <Text style={[styles.time, { color: C.accentText }]}>{String(prefs.rate).replace('.', ',')}×</Text>}
            <Ctl icon={full ? 'contract' : 'expand'} label={full ? 'Quitter le plein écran' : 'Plein écran'} onPress={() => (full ? exitFull() : enterFull())} size={20} />
          </View>
        </View>
      ) : null}

      {!locked && (skipVisible || showNext) && (
        <View pointerEvents="box-none" style={[styles.pillWrap, { bottom: bottomOffset, right: sideInset }]}>
          {skipVisible && skipBtn && (
            <Pill icon="play-skip-forward" label={skipBtn.label}
              onPress={() => { seekTo(skipBtn.to); setSkipped((s) => [...s, skipBtn.key]); }} />
          )}
          {showNext && <Pill primary icon="play-skip-forward" label="Épisode suivant" onPress={playNext} />}
        </View>
      )}

      {next && countdown !== null && (
        <NextCard label={next.label} countdown={countdown} onCancel={() => setCountdown(null)} onPlay={playNext} warning={next.warning}
          style={{ right: sideInset, bottom: full ? Math.max(insets.bottom, S.lg) + 8 : S.md }} />
      )}

      {/* Comments over the video (landscape) */}
      {full && commentsOpen && renderComments && (
        <Animated.View
          entering={(panelLeft ? SlideInLeft : SlideInRight).duration(240)}
          exiting={(panelLeft ? SlideOutLeft : SlideOutRight).duration(200)}
          style={[styles.panel, { width: panelW + (panelLeft ? insets.left : insets.right) }, panelLeft ? { left: 0, paddingLeft: insets.left } : { right: 0, paddingRight: insets.right }]}>
          <View style={styles.panelHead}>
            <Txt v="section" style={{ fontSize: 15, flex: 1 }}>Commentaires</Txt>
            <Pressable onPress={() => setPrefs({ commentsSide: panelLeft ? 'right' : 'left' })} hitSlop={10} accessibilityRole="button"
              accessibilityLabel={panelLeft ? 'Mettre le panneau à droite' : 'Mettre le panneau à gauche'}>
              <Ionicons name="swap-horizontal" size={20} color={C.text2} />
            </Pressable>
            <Pressable onPress={() => setCommentsOpen(false)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Fermer les commentaires">
              <Ionicons name="close" size={22} color={C.text} />
            </Pressable>
          </View>
          <View style={{ flex: 1 }}>{renderComments()}</View>
        </Animated.View>
      )}

      <PlayerSettings
        visible={settings}
        onClose={() => { setSettings(false); wake(); }}
        rate={prefs.rate}
        onRate={(rate) => setPrefs({ rate })}
        audio={audioOptions}
        audioKey={audioKey}
        onAudio={(k) => {
          const tr = audioTracks[Number(k)];
          if (!tr) return;
          audioPicked.current = source?.uri ?? null;
          setProp(player, 'audioTrack', tr);
        }}
        // One modal at a time: iOS does not present a modal while another one is still on screen
        // (the subtitle sheet would never show and could not be closed), so it opens once the
        // settings sheet is gone.
        onOpenSubtitles={() => { subsAfterSettings.current = true; setSettings(false); }}
        onClosed={() => {
          if (!subsAfterSettings.current) return;
          subsAfterSettings.current = false;
          setSubSheet(true);
        }}
        autoNext={prefs.autoNext}
        onAutoNext={(autoNext) => setPrefs({ autoNext })}
        commentsSide={prefs.commentsSide}
        onCommentsSide={(commentsSide) => setPrefs({ commentsSide })}
        liveComments={prefs.liveComments}
        onLiveComments={(liveComments) => setPrefs({ liveComments })}
        sourceInfo={sourceInfo}
      />
      <SubtitleSheet visible={subSheet} onClose={() => { setSubSheet(false); wake(); }} ctl={subs} />
    </View>
  );
}

const shadow = { textShadowColor: 'rgba(0,0,0,0.95)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 } as const;

const styles = StyleSheet.create({
  inline: { width: '100%', aspectRatio: 16 / 9, backgroundColor: C.black, overflow: 'hidden' },
  full: { flex: 1, backgroundColor: C.black, overflow: 'hidden' },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: S.sm },
  emptyAction: { marginTop: S.xs, paddingHorizontal: S.lg, paddingVertical: 9, borderRadius: 999, backgroundColor: C.accent },
  emptyActionText: { color: C.onAccent, fontSize: 14, ...F.heavy },
  topRow: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: S.xs, padding: S.xs },
  airplay: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  middle: { ...StyleSheet.absoluteFill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 40 },
  bigCtl: {
    backgroundColor: 'rgba(16,21,34,0.42)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    boxShadow: '0px 8px 24px -8px rgba(0,0,0,0.6)',
  },
  glyphShadow: { textShadowColor: 'rgba(0,0,0,0.45)', textShadowRadius: 6, textShadowOffset: { width: 0, height: 1 } },
  skip: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  skipText: { position: 'absolute', color: C.white, fontSize: 11, ...F.heavy, marginTop: 5, fontVariant: ['tabular-nums'] },
  scrimTop: { position: 'absolute', left: 0, right: 0, top: 0 },
  scrimBottom: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  titleShadow: { textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 6 },
  bottomRow: {
    position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingLeft: S.md, paddingRight: S.xs, paddingBottom: 2,
  },
  time: { color: C.white, fontSize: 13, fontVariant: ['tabular-nums'], ...F.semibold, minWidth: 38, textAlign: 'center', ...shadow },
  chipBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, maxWidth: 200, paddingHorizontal: 13,
    borderRadius: R.pill, backgroundColor: 'rgba(16,21,34,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
  },
  chipText: { color: C.white, fontSize: 13, ...F.semibold },
  pillWrap: { position: 'absolute', flexDirection: 'row', gap: S.sm },
  pillText: { color: C.bg, fontSize: 13, ...F.bold },
  unlock: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 16,
    borderRadius: R.pill, backgroundColor: C.white,
  },
  flash: {
    position: 'absolute', top: 0, bottom: 0, width: '32%', alignItems: 'center', justifyContent: 'center', gap: 4,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  flashText: { color: C.white, fontSize: 13, ...F.bold, ...shadow },
  hud: {
    position: 'absolute', top: S.xl, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 9, paddingHorizontal: 16, borderRadius: R.pill, backgroundColor: 'rgba(12,17,28,0.82)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  hudTrack: { width: 120, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden' },
  hudFill: { height: 4, backgroundColor: C.white },
  hudText: { color: C.white, fontSize: 12, width: 26, textAlign: 'right', fontVariant: ['tabular-nums'], ...F.semibold },
  notice: {
    position: 'absolute', alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 7, borderRadius: R.pill,
    backgroundColor: 'rgba(12,17,28,0.82)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  live: { position: 'absolute', maxWidth: 360, gap: 6 },
  liveRow: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 12, backgroundColor: 'rgba(5,7,13,0.62)', gap: 1 },
  liveAuthor: { color: C.accentText, fontSize: 11, ...F.bold },
  liveText: { color: C.white, fontSize: 13, ...F.medium },
  panel: {
    position: 'absolute', top: 0, bottom: 0, backgroundColor: 'rgba(8,11,18,0.82)',
    borderColor: 'rgba(255,255,255,0.08)', borderLeftWidth: 1, borderRightWidth: 1,
  },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingTop: S.lg, paddingBottom: S.sm },
});
