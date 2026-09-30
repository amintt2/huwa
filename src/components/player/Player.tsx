// Huwa video player: expo-video + custom controls (nativeControls off).
// - external SRT/VTT subtitles drawn as an overlay (expo-video has no sidecar subtitle API)
// - embedded audio / subtitle tracks (player.audioTrack / player.subtitleTrack), speed
// - AniSkip opening / ending / recap segments: skip buttons during the segment, markers on the bar,
//   "Épisode suivant" during the ending + cancellable countdown (fallbacks: +85 s, last 90 s)
// - landscape: rotating the phone (or the button) goes fullscreen; double-tap ±10 s, vertical drag
//   = brightness (left) / volume (right), screen lock, comments panel over the video, live comments
// - PiP, AirPlay, resume position (`startAt`), progress saved every 5 s (`onProgress`)
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEvent, useEventListener } from 'expo';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import {
  isPictureInPictureSupported,
  useVideoPlayer,
  VideoAirPlayButton,
  VideoView,
  type AudioTrack,
  type SubtitleTrack,
  type VideoPlayer,
} from 'expo-video';
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { ActivityIndicator, BackHandler, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInLeft, SlideInRight, SlideOutLeft, SlideOutRight } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Txt, type IconName } from '@/components/ui';
import { C, F, R, S } from '@/theme/tokens';

import { useSkipTimes, type Segment } from './aniskip';
import { GestureLayer, type Hud } from './GestureLayer';
import { AUTO_NEXT_SECONDS, NextCard, Pill } from './overlays';
import { PlayerSettings, type Option } from './PlayerSettings';
import { SUBTITLE_SIZES, getPrefs, setPrefs, usePrefs } from './prefs';
import { formatTime, SeekBar } from './SeekBar';
import { cueAt, useCues, type ExternalSubtitle } from './subtitles';

export type { ExternalSubtitle } from './subtitles';

export type PlayerSource = { uri: string; headers?: Record<string, string> };

export type PlayerHandle = {
  getTime: () => number;
  seekTo: (seconds: number) => void;
  play: () => void;
  pause: () => void;
};

export type TimedComment = { id: string; author: string; text: string; timestamp: number };

export type PlayerProps = {
  ref?: Ref<PlayerHandle>;
  source?: PlayerSource | null;
  title: string;
  subtitle?: string;
  artwork?: string;
  /** External subtitle files (SRT or VTT). */
  subtitles?: ExternalSubtitle[];
  /** Resume position in seconds, read when the first source finishes loading. */
  startAt?: () => number | undefined;
  /** Throttled (5 s) and on leave. */
  onProgress?: (position: number, duration: number) => void;
  onEnd?: () => void;
  /** Playback failed on the current source (the parent can try another one). */
  onError?: (message: string) => void;
  next?: { label: string; onPlay: () => void } | null;
  /** MyAnimeList id + episode number → AniSkip timestamps. */
  malId?: number | null;
  episodeNumber?: number;
  /** Seconds skipped by "Passer l'intro" when AniSkip has no data. */
  introSkip?: number;
  /** Text shown when there is no source yet. */
  emptyText?: string;
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
};

const INTRO_WINDOW = 180;
const NEXT_WINDOW = 90;
const LIVE_COMMENT_SECONDS = 7;
const hitSlop = 10;

function Ctl({ icon, label, onPress, size = 22, big, active }: { icon: IconName; label: string; onPress: () => void; size?: number; big?: boolean; active?: boolean }) {
  const d = big ? 64 : 40;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        { width: d, height: d, borderRadius: d / 2, alignItems: 'center', justifyContent: 'center' },
        big && { backgroundColor: 'rgba(5,7,13,0.45)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' },
        active && { backgroundColor: C.accentSoft },
        pressed && { opacity: 0.6, transform: [{ scale: 0.94 }] },
      ]}>
      <Ionicons name={icon} size={big ? 30 : size} color={active ? C.accentText : C.white} />
    </Pressable>
  );
}

/** Imperative player writes (kept out of render so the React Compiler treats `player` as opaque). */
function setProp<K extends 'currentTime' | 'playbackRate' | 'subtitleTrack' | 'audioTrack' | 'volume'>(p: VideoPlayer, k: K, v: VideoPlayer[K]) {
  p[k] = v;
}

const lockOrientation = (lock: ScreenOrientation.OrientationLock) => ScreenOrientation.lockAsync(lock).catch(() => {});

const subKeyOf = {
  external: (s: ExternalSubtitle) => `ext:${s.url}`,
  embedded: (i: number) => `emb:${i}`,
};

const sameLang = (a?: string, b?: string) => !!a && !!b && a.slice(0, 2).toLowerCase() === b.slice(0, 2).toLowerCase();

export function Player({
  ref,
  source,
  title,
  subtitle,
  artwork,
  subtitles = [],
  startAt,
  onProgress,
  onEnd,
  onError,
  next,
  malId,
  episodeNumber = 1,
  introSkip = 85,
  emptyText = 'Choisis une source pour lancer la lecture.',
  notice,
  onFullscreenChange,
  onOpenSources,
  sourceLabel,
  renderComments,
  commentCount,
  timedComments = [],
}: PlayerProps) {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const prefs = usePrefs();
  const view = useRef<VideoView>(null);
  const lastSave = useRef(0);
  const loadedOnce = useRef(false);
  const cb = useRef({ startAt, onProgress, onEnd, onError, next, onFullscreenChange });
  useEffect(() => {
    cb.current = { startAt, onProgress, onEnd, onError, next, onFullscreenChange };
  });

  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 0.25;
    p.allowsExternalPlayback = true;
    p.showNowPlayingNotification = true;
  });

  const [time, setTime] = useState({ t: 0, buffered: 0 });
  const [duration, setDuration] = useState(0);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [audioTrack, setAudioTrack] = useState<AudioTrack | null>(null);
  const [embedded, setEmbedded] = useState<SubtitleTrack[]>([]);
  const [userSub, setUserSub] = useState<string | undefined>();
  const [controls, setControls] = useState(true);
  const [touch, setTouch] = useState(0);
  const [settings, setSettings] = useState(false);
  const [locked, setLocked] = useState(false);
  const [unlockHint, setUnlockHint] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [hud, setHud] = useState<Hud | null>(null);
  const [flash, setFlash] = useState<{ side: 'left' | 'right'; n: number } | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [ended, setEnded] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [pip, setPip] = useState(false);

  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const { status, error } = useEvent(player, 'statusChange', { status: player.status, error: undefined });

  // ---------- fullscreen = landscape ----------
  const full = window.width > window.height;
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
  const headersKey = JSON.stringify(source?.headers ?? {});
  useEffect(() => {
    if (!source?.uri) return;
    let alive = true;
    // Switching source mid-episode (quality upgrade, fallback, manual pick) keeps the position.
    const keep = loadedOnce.current ? player.currentTime : undefined;
    player
      .replaceAsync({ uri: source.uri, headers: source.headers, metadata: { title, artist: subtitle, artwork } })
      .then(() => {
        if (!alive) return;
        const at = keep != null && keep > 1 ? keep : cb.current.startAt?.();
        if (at && at > 1) setProp(player, 'currentTime', at);
        loadedOnce.current = true;
        setEnded(false);
        setCountdown(null);
        player.play();
      })
      .catch((e: unknown) => cb.current.onError?.(e instanceof Error ? e.message : 'Lecture impossible'));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.uri, headersKey, player]);

  useEventListener(player, 'sourceLoad', (e) => {
    setDuration(e.duration);
    setAudioTracks(e.availableAudioTracks);
    setEmbedded(e.availableSubtitleTracks);
    setAudioTrack(player.audioTrack);
  });
  useEventListener(player, 'statusChange', ({ status: s, error: err }) => {
    if (s === 'readyToPlay' && isFinite(player.duration)) setDuration(player.duration);
    if (s === 'error') cb.current.onError?.(err?.message ?? 'Lecture impossible');
  });
  useEventListener(player, 'availableAudioTracksChange', (e) => setAudioTracks(e.availableAudioTracks));
  useEventListener(player, 'availableSubtitleTracksChange', (e) => setEmbedded(e.availableSubtitleTracks));
  useEventListener(player, 'audioTrackChange', (e) => setAudioTrack(e.audioTrack));

  // ---------- AniSkip segments ----------
  const { segments, loaded: skipLoaded } = useSkipTimes(malId, episodeNumber, duration);
  const intro = segments.find((s) => s.kind === 'intro');
  const outro = segments.find((s) => s.kind === 'outro');
  const segRef = useRef<{ outro?: Segment; countdownFired: boolean }>({ countdownFired: false });
  useEffect(() => {
    segRef.current.outro = outro;
  }, [outro]);

  useEventListener(player, 'timeUpdate', ({ currentTime, bufferedPosition }) => {
    setTime({ t: currentTime, buffered: bufferedPosition });
    // The ending started: offer the next episode with a cancellable countdown (once).
    const o = segRef.current.outro;
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

  // Save on leave.
  useEffect(
    () => () => {
      try {
        cb.current.onProgress?.(player.currentTime, player.duration);
      } catch {
        // player already released
      }
    },
    [player],
  );

  // ---------- auto next ----------
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      cb.current.next?.onPlay();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  // ---------- speed ----------
  useEffect(() => {
    setProp(player, 'playbackRate', prefs.rate);
  }, [player, prefs.rate]);

  // ---------- subtitles ----------
  const autoSub = useMemo(() => {
    if (prefs.subLang === 'off') return 'off';
    const ext = subtitles.find((s) => sameLang(s.lang, prefs.subLang));
    if (ext) return subKeyOf.external(ext);
    const i = embedded.findIndex((s) => sameLang(s.language, prefs.subLang));
    return i >= 0 ? subKeyOf.embedded(i) : 'off';
  }, [prefs.subLang, subtitles, embedded]);
  const subKey = userSub ?? autoSub;
  const extUrl = subKey.startsWith('ext:') ? subKey.slice(4) : undefined;
  const embIndex = subKey.startsWith('emb:') ? Number(subKey.slice(4)) : -1;

  useEffect(() => {
    try {
      setProp(player, 'subtitleTrack', embedded[embIndex] ?? null);
    } catch {
      // not supported on this platform
    }
  }, [player, embedded, embIndex]);

  const { cues, loading: cuesLoading, error: cuesError } = useCues(extUrl);
  const line = extUrl ? cueAt(cues, time.t) : null;

  const subOptions: Option[] = [
    { key: 'off', label: 'Désactivés' },
    ...subtitles.map((s) => ({ key: subKeyOf.external(s), label: s.label, hint: `${s.lang.toUpperCase()} · externe` })),
    ...embedded.map((s, i) => ({ key: subKeyOf.embedded(i), label: s.label || s.name || s.language, hint: `${(s.language || '?').toUpperCase()} · intégré` })),
  ];
  const pickSub = (k: string) => {
    setUserSub(k);
    if (k === 'off') return setPrefs({ subLang: 'off' });
    const lang = k.startsWith('ext:') ? subtitles.find((s) => subKeyOf.external(s) === k)?.lang : embedded[Number(k.slice(4))]?.language;
    if (lang) setPrefs({ subLang: lang });
  };

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
        setProp(player, 'currentTime', Math.max(0, t));
        player.play();
      },
      play: () => player.play(),
      pause: () => player.pause(),
    }),
    [player],
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
    // Fallback while AniSkip has nothing: +85 s during the first 3 minutes.
    if (skipLoaded && !intro && !skipped.includes('intro') && t >= 2 && t < INTRO_WINDOW && (duration === 0 || duration > introSkip + 60)) {
      return { key: 'intro', label: 'Passer l’intro', to: t + introSkip };
    }
    return null;
  })();
  const showNext = !!next && !ended && countdown === null && duration > 60 && (outro ? t >= outro.start : duration - t <= NEXT_WINDOW);
  const markers = segments.filter((s) => s.kind !== 'recap');

  // ---------- live comments ----------
  const live = full && prefs.liveComments && !commentsOpen
    ? timedComments.filter((c) => c.timestamp <= t && t - c.timestamp < LIVE_COMMENT_SECONDS).slice(-3)
    : [];

  const pipOk = Platform.OS !== 'web' && isPictureInPictureSupported();
  const loading = !!source?.uri && (status === 'loading' || (status === 'idle' && !ended));
  const remaining = duration - t;
  const subSize = SUBTITLE_SIZES[prefs.subSize] * (full ? 1.3 : 1);
  const sideInset = full ? Math.max(insets.left, insets.right, S.lg) : S.md;
  const panelW = Math.min(420, window.width * 0.42);
  const panelLeft = prefs.commentsSide === 'left';
  const bottomOffset = controls ? (full ? 76 + Math.max(insets.bottom - 8, 0) : 52) : full ? 24 : 12;

  return (
    <View style={full ? styles.full : styles.inline}>
      {full && <StatusBar hidden animated />}
      <VideoView
        ref={view}
        player={player}
        style={StyleSheet.absoluteFill}
        nativeControls={false}
        contentFit="contain"
        allowsPictureInPicture
        startsPictureInPictureAutomatically
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
      />

      {!!line && !pip && (
        <View pointerEvents="none" style={[styles.subWrap, { bottom: bottomOffset }]}>
          <Text style={[styles.sub, { fontSize: subSize, lineHeight: subSize * 1.28 }]}>{line}</Text>
        </View>
      )}

      {!source?.uri && (
        <View pointerEvents="none" style={styles.center}>
          <Ionicons name="play-circle-outline" size={36} color={C.text2} />
          <Txt v="small" style={{ textAlign: 'center', paddingHorizontal: S.xl }}>{emptyText}</Txt>
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

      {!!notice && (
        <View pointerEvents="none" style={[styles.notice, { top: full ? S.lg : S.sm }]}>
          <Txt v="small" color={C.white}>{notice}</Txt>
        </View>
      )}

      {/* Live time-anchored comments */}
      {live.length > 0 && (
        <View pointerEvents="none" style={[styles.live, { bottom: bottomOffset + 8 }, panelLeft ? { right: sideInset } : { left: sideInset }]}>
          {live.map((c) => (
            <Animated.View key={c.id} entering={FadeIn.duration(220)} exiting={FadeOut.duration(220)} style={styles.liveRow}>
              <Text style={styles.liveAuthor}>{c.author}</Text>
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
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.42)' }]} />

          <View pointerEvents="box-none" style={[styles.topRow, full && { paddingTop: Math.max(insets.top, S.md), paddingHorizontal: sideInset }]}>
            {full ? (
              <>
                <Ctl icon="chevron-down" label="Quitter le plein écran" onPress={exitFull} />
                <View style={{ flex: 1, gap: 1 }}>
                  <Txt v="label" numberOfLines={1}>{title}</Txt>
                  {!!subtitle && <Txt v="small" numberOfLines={1}>{subtitle}</Txt>}
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
            {pipOk && <Ctl icon="albums-outline" label="Image dans l’image" onPress={() => view.current?.startPictureInPicture().catch(() => {})} />}
            <Ctl icon="settings-outline" label="Réglages de lecture" onPress={() => { setSettings(true); wake(); }} />
          </View>

          <View pointerEvents="box-none" style={[styles.middle, full && { gap: 72 }]}>
            <Ctl icon="play-back" label="Reculer de 10 secondes" onPress={() => { seekTo(t - 10); wake(); }} size={26} />
            {loading ? (
              <View style={{ width: 64, height: 64, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={C.white} size="large" /></View>
            ) : ended ? (
              <Ctl big icon="refresh" label="Revoir" onPress={() => { seekTo(0); player.play(); wake(); }} />
            ) : (
              <Ctl big icon={isPlaying ? 'pause' : 'play'} label={isPlaying ? 'Pause' : 'Lecture'}
                onPress={() => { if (isPlaying) player.pause(); else player.play(); wake(); }} />
            )}
            <Ctl icon="play-forward" label="Avancer de 10 secondes" onPress={() => { seekTo(t + 10); wake(); }} size={26} />
          </View>

          <View pointerEvents="box-none" style={[styles.bottomRow, full && { paddingBottom: Math.max(insets.bottom, S.md), paddingHorizontal: sideInset }]}>
            <Text style={styles.time}>{formatTime(t)}</Text>
            <SeekBar position={t} duration={duration} buffered={time.buffered} markers={markers} onScrubStart={wake} onSeek={(x) => { seekTo(x); wake(); }} />
            <Text style={styles.time}>{duration > 0 ? `-${formatTime(Math.max(0, remaining))}` : '--:--'}</Text>
            {prefs.rate !== 1 && <Text style={[styles.time, { color: C.accentText }]}>{String(prefs.rate).replace('.', ',')}×</Text>}
            <Ctl icon={full ? 'contract' : 'expand'} label={full ? 'Quitter le plein écran' : 'Plein écran'} onPress={() => (full ? exitFull() : enterFull())} size={20} />
          </View>
        </View>
      ) : null}

      {!locked && (skipBtn || showNext) && (
        <View pointerEvents="box-none" style={[styles.pillWrap, { bottom: bottomOffset, right: sideInset }]}>
          {skipBtn && (
            <Pill icon="play-skip-forward" label={skipBtn.label}
              onPress={() => { seekTo(skipBtn.to); setSkipped((s) => [...s, skipBtn.key]); }} />
          )}
          {showNext && <Pill primary icon="play-skip-forward" label="Épisode suivant" onPress={() => next!.onPlay()} />}
        </View>
      )}

      {next && countdown !== null && (
        <NextCard label={next.label} countdown={countdown} onCancel={() => setCountdown(null)} onPlay={() => next.onPlay()}
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
          if (tr) setProp(player, 'audioTrack', tr);
        }}
        subtitles={subOptions}
        subtitleKey={subKey}
        onSubtitle={pickSub}
        subtitleNote={cuesLoading ? 'Chargement des sous-titres…' : cuesError ? 'Sous-titres injoignables.' : subOptions.length === 1 ? 'Aucun sous-titre pour cette source.' : undefined}
        size={prefs.subSize}
        onSize={(s) => setPrefs({ subSize: s })}
        autoNext={prefs.autoNext}
        onAutoNext={(autoNext) => setPrefs({ autoNext })}
        commentsSide={prefs.commentsSide}
        onCommentsSide={(commentsSide) => setPrefs({ commentsSide })}
        liveComments={prefs.liveComments}
        onLiveComments={(liveComments) => setPrefs({ liveComments })}
      />
    </View>
  );
}

const shadow = { textShadowColor: 'rgba(0,0,0,0.95)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 } as const;

const styles = StyleSheet.create({
  inline: { width: '100%', aspectRatio: 16 / 9, backgroundColor: C.black, overflow: 'hidden' },
  full: { flex: 1, backgroundColor: C.black, overflow: 'hidden' },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: S.sm },
  topRow: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: S.xs, padding: S.xs },
  airplay: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  middle: { ...StyleSheet.absoluteFill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 36 },
  bottomRow: {
    position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingLeft: S.md, paddingRight: S.xs, paddingBottom: 2,
  },
  time: { color: C.white, fontSize: 12, fontVariant: ['tabular-nums'], ...F.semibold, ...shadow },
  chipBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, maxWidth: 180, paddingHorizontal: 12,
    borderRadius: R.pill, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)',
  },
  chipText: { color: C.white, fontSize: 12, ...F.semibold },
  subWrap: { position: 'absolute', left: S.lg, right: S.lg, alignItems: 'center' },
  sub: {
    color: C.white, textAlign: 'center', ...F.semibold, backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, overflow: 'hidden', ...shadow,
  },
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
    paddingVertical: 8, paddingHorizontal: 14, borderRadius: R.pill, backgroundColor: 'rgba(5,7,13,0.75)',
  },
  hudTrack: { width: 120, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden' },
  hudFill: { height: 4, backgroundColor: C.white },
  hudText: { color: C.white, fontSize: 12, width: 26, textAlign: 'right', fontVariant: ['tabular-nums'], ...F.semibold },
  notice: { position: 'absolute', alignSelf: 'center', paddingHorizontal: S.md, paddingVertical: 6, borderRadius: R.pill, backgroundColor: 'rgba(0,0,0,0.7)' },
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
