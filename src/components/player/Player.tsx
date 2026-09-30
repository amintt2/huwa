// Huwa video player: expo-video with custom controls.
// - external SRT/VTT subtitles drawn as an overlay (expo-video has no sidecar subtitle API)
// - embedded audio / subtitle tracks (player.audioTrack / player.subtitleTrack)
// - speed, "Passer l'intro", auto next episode with countdown, PiP, AirPlay, landscape fullscreen
// - resume position: `startAt()` is read when a source is loaded, `onProgress` is throttled (5 s)
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
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { ActivityIndicator, BackHandler, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Txt, type IconName } from '@/components/ui';
import { C, F, R, S } from '@/theme/tokens';

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

export type PlayerProps = {
  ref?: Ref<PlayerHandle>;
  source?: PlayerSource | null;
  title: string;
  subtitle?: string;
  artwork?: string;
  /** External subtitle files (SRT or VTT). */
  subtitles?: ExternalSubtitle[];
  /** Resume position in seconds, read each time a source finishes loading. */
  startAt?: () => number | undefined;
  /** Throttled (5 s) and on leave. */
  onProgress?: (position: number, duration: number) => void;
  onEnd?: () => void;
  next?: { label: string; onPlay: () => void } | null;
  /** Seconds skipped by "Passer l'intro". */
  introSkip?: number;
  /** Text shown when there is no source yet. */
  emptyText?: string;
  /** The parent should hide everything else and give the player the whole screen while `true`. */
  onFullscreenChange?: (full: boolean) => void;
};

const AUTO_NEXT_SECONDS = 8;
const INTRO_WINDOW = 180;
const hitSlop = 10;

function Ctl({ icon, label, onPress, size = 22, big }: { icon: IconName; label: string; onPress: () => void; size?: number; big?: boolean }) {
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
        pressed && { opacity: 0.6, transform: [{ scale: 0.94 }] },
      ]}>
      <Ionicons name={icon} size={big ? 30 : size} color={C.white} />
    </Pressable>
  );
}

const subKeyOf = {
  external: (s: ExternalSubtitle) => `ext:${s.url}`,
  embedded: (i: number) => `emb:${i}`,
};

/** Imperative player writes (kept out of render so the React Compiler treats `player` as opaque). */
function setProp<K extends 'currentTime' | 'playbackRate' | 'subtitleTrack' | 'audioTrack'>(p: VideoPlayer, k: K, v: VideoPlayer[K]) {
  p[k] = v;
}

const sameLang =(a?: string, b?: string) => !!a && !!b && a.slice(0, 2).toLowerCase() === b.slice(0, 2).toLowerCase();

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
  next,
  introSkip = 85,
  emptyText = 'Choisis une source pour lancer la lecture.',
  onFullscreenChange,
}: PlayerProps) {
  const insets = useSafeAreaInsets();
  const prefs = usePrefs();
  const view = useRef<VideoView>(null);
  const lastSave = useRef(0);
  const cb = useRef({ startAt, onProgress, onEnd, next, onFullscreenChange });
  useEffect(() => {
    cb.current = { startAt, onProgress, onEnd, next, onFullscreenChange };
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
  const [full, setFull] = useState(false);
  const [introDone, setIntroDone] = useState(false);
  const [ended, setEnded] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [pip, setPip] = useState(false);

  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const { status, error } = useEvent(player, 'statusChange', { status: player.status, error: undefined });

  // ---------- source & resume ----------
  const headersKey = JSON.stringify(source?.headers ?? {});
  useEffect(() => {
    if (!source?.uri) return;
    let alive = true;
    player
      .replaceAsync({ uri: source.uri, headers: source.headers, metadata: { title, artist: subtitle, artwork } })
      .then(() => {
        if (!alive) return;
        setEnded(false);
        setCountdown(null);
        const at = cb.current.startAt?.();
        if (at && at > 5) setProp(player, 'currentTime', at);
        player.play();
      })
      .catch(() => {});
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
  useEventListener(player, 'statusChange', ({ status: s }) => {
    if (s === 'readyToPlay' && isFinite(player.duration)) setDuration(player.duration);
  });
  useEventListener(player, 'availableAudioTracksChange', (e) => setAudioTracks(e.availableAudioTracks));
  useEventListener(player, 'availableSubtitleTracksChange', (e) => setEmbedded(e.availableSubtitleTracks));
  useEventListener(player, 'audioTrackChange', (e) => setAudioTrack(e.audioTrack));

  useEventListener(player, 'timeUpdate', ({ currentTime, bufferedPosition }) => {
    setTime({ t: currentTime, buffered: bufferedPosition });
    if (Date.now() - lastSave.current < 5000) return;
    lastSave.current = Date.now();
    cb.current.onProgress?.(currentTime, player.duration);
  });

  useEventListener(player, 'playToEnd', () => {
    setEnded(true);
    setControls(true);
    cb.current.onEnd?.();
    if (cb.current.next && getPrefs().autoNext) setCountdown(AUTO_NEXT_SECONDS);
  });

  // Save on leave; put the app back in portrait.
  useEffect(
    () => () => {
      try {
        cb.current.onProgress?.(player.currentTime, player.duration);
      } catch {
        // player already released
      }
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
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
    const t = setTimeout(() => setControls(false), 60000);
    return () => clearTimeout(t);
  }, [controls, isPlaying, settings, touch]);

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

  const toggleFull = (on: boolean) => {
    setFull(on);
    cb.current.onFullscreenChange?.(on);
    wake();
    ScreenOrientation.lockAsync(on ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  };

  // Android back button leaves fullscreen first.
  useEffect(() => {
    if (!full) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setFull(false);
      cb.current.onFullscreenChange?.(false);
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
      return true;
    });
    return () => sub.remove();
  }, [full]);

  const pipOk = Platform.OS !== 'web' && isPictureInPictureSupported();
  const loading = !!source?.uri && (status === 'loading' || (status === 'idle' && !ended));
  const remaining = duration - time.t;
  const showIntro = !introDone && !ended && time.t >= 2 && time.t < INTRO_WINDOW && (duration === 0 || duration > introSkip + 60);
  const showNextSoon = !!next && !ended && duration > 60 && remaining > 0 && remaining <= 30;
  const subSize = SUBTITLE_SIZES[prefs.subSize] * (full ? 1.3 : 1);

  const stage = (isFull: boolean) => (
    <View style={StyleSheet.absoluteFill}>
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

      {/* Tap anywhere to show / hide the controls */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => (controls ? setControls(false) : wake())}
        accessibilityLabel={controls ? 'Masquer les commandes' : 'Afficher les commandes'}
      />

      {!!line && !pip && (
        <View pointerEvents="none" style={[styles.subWrap, { bottom: controls ? (isFull ? 84 : 58) : isFull ? 28 : 12 }]}>
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

      {controls && (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.42)' }]} />

          <View pointerEvents="box-none" style={[styles.topRow, isFull && { paddingTop: S.md, paddingHorizontal: Math.max(insets.left, insets.right, S.lg) }]}>
            {isFull ? (
              <>
                <Ctl icon="chevron-down" label="Quitter le plein écran" onPress={() => toggleFull(false)} />
                <View style={{ flex: 1, gap: 1 }}>
                  <Txt v="label" numberOfLines={1}>{title}</Txt>
                  {!!subtitle && <Txt v="small" numberOfLines={1}>{subtitle}</Txt>}
                </View>
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

          <View pointerEvents="box-none" style={styles.middle}>
            <Ctl icon="play-back" label="Reculer de 10 secondes" onPress={() => { seekTo(time.t - 10); wake(); }} size={26} />
            {loading ? (
              <View style={{ width: 64, height: 64, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={C.white} size="large" /></View>
            ) : ended ? (
              <Ctl big icon="refresh" label="Revoir" onPress={() => { seekTo(0); player.play(); wake(); }} />
            ) : (
              <Ctl big icon={isPlaying ? 'pause' : 'play'} label={isPlaying ? 'Pause' : 'Lecture'}
                onPress={() => { if (isPlaying) player.pause(); else player.play(); wake(); }} />
            )}
            <Ctl icon="play-forward" label="Avancer de 10 secondes" onPress={() => { seekTo(time.t + 10); wake(); }} size={26} />
          </View>

          <View pointerEvents="box-none" style={[styles.bottomRow, isFull && { paddingBottom: Math.max(insets.bottom, S.md), paddingHorizontal: Math.max(insets.left, insets.right, S.lg) }]}>
            <Text style={styles.time}>{formatTime(time.t)}</Text>
            <SeekBar position={time.t} duration={duration} buffered={time.buffered} onScrubStart={wake} onSeek={(t) => { seekTo(t); wake(); }} />
            <Text style={styles.time}>{duration > 0 ? `-${formatTime(Math.max(0, remaining))}` : '--:--'}</Text>
            {prefs.rate !== 1 && <Text style={[styles.time, { color: C.accentText }]}>{String(prefs.rate).replace('.', ',')}×</Text>}
            <Ctl icon={isFull ? 'contract' : 'expand'} label={isFull ? 'Quitter le plein écran' : 'Plein écran'} onPress={() => toggleFull(!isFull)} size={20} />
          </View>
        </View>
      )}

      {(showIntro || showNextSoon) && (
        <View pointerEvents="box-none" style={[styles.pillWrap, { bottom: controls ? (isFull ? 84 : 52) : isFull ? 28 : 12, right: isFull ? Math.max(insets.right, S.lg) : S.md }]}>
          {showIntro && (
            <Pressable style={styles.pill} accessibilityRole="button" accessibilityLabel="Passer l’intro"
              onPress={() => { seekTo(time.t + introSkip); setIntroDone(true); }}>
              <Ionicons name="play-skip-forward" size={14} color={C.bg} />
              <Text style={styles.pillText}>Passer l’intro</Text>
            </Pressable>
          )}
          {showNextSoon && (
            <Pressable style={styles.pill} accessibilityRole="button" accessibilityLabel={`Épisode suivant : ${next!.label}`} onPress={() => next!.onPlay()}>
              <Ionicons name="play-skip-forward" size={14} color={C.bg} />
              <Text style={styles.pillText}>Épisode suivant</Text>
            </Pressable>
          )}
        </View>
      )}

      {ended && next && countdown !== null && (
        <View style={styles.nextCard}>
          <Txt v="caption" color={C.accentText}>ÉPISODE SUIVANT DANS {countdown} S</Txt>
          <Txt v="label" numberOfLines={1}>{next.label}</Txt>
          <View style={{ flexDirection: 'row', gap: S.sm }}>
            <Pressable style={[styles.cardBtn, { backgroundColor: C.elevated }]} onPress={() => setCountdown(null)} accessibilityRole="button">
              <Text style={[styles.pillText, { color: C.text }]}>Annuler</Text>
            </Pressable>
            <Pressable style={[styles.cardBtn, { backgroundColor: C.accent }]} onPress={() => next.onPlay()} accessibilityRole="button">
              <Ionicons name="play" size={14} color={C.white} />
              <Text style={[styles.pillText, { color: C.white }]}>Lire maintenant</Text>
            </Pressable>
          </View>
        </View>
      )}

      <PlayerSettings
        visible={settings}
        onClose={() => { setSettings(false); wake(); }}
        rate={prefs.rate}
        onRate={(rate) => setPrefs({ rate })}
        audio={audioOptions}
        audioKey={audioKey}
        onAudio={(k) => {
          const t = audioTracks[Number(k)];
          if (t) setProp(player, 'audioTrack', t);
        }}
        subtitles={subOptions}
        subtitleKey={subKey}
        onSubtitle={pickSub}
        subtitleNote={cuesLoading ? 'Chargement des sous-titres…' : cuesError ? 'Sous-titres injoignables.' : subOptions.length === 1 ? 'Aucun sous-titre pour cette source.' : undefined}
        size={prefs.subSize}
        onSize={(subSize) => setPrefs({ subSize })}
        autoNext={prefs.autoNext}
        onAutoNext={(autoNext) => setPrefs({ autoNext })}
      />
    </View>
  );

  // Fullscreen = the same view grown to fill the screen (the parent hides its other content via
  // `onFullscreenChange`) + landscape lock. Keeping one VideoView avoids a remount / black frame.
  return (
    <View style={full ? styles.full : styles.inline}>
      {full && <StatusBar hidden animated />}
      {stage(full)}
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
  subWrap: { position: 'absolute', left: S.lg, right: S.lg, alignItems: 'center' },
  sub: {
    color: C.white, textAlign: 'center', ...F.semibold, backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, overflow: 'hidden', ...shadow,
  },
  pillWrap: { position: 'absolute', flexDirection: 'row', gap: S.sm },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 9, paddingHorizontal: 14,
    borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.white,
  },
  pillText: { color: C.bg, fontSize: 13, ...F.bold },
  nextCard: {
    position: 'absolute', right: S.md, bottom: S.md, maxWidth: 320, gap: 6, padding: S.md,
    borderRadius: R.card, borderCurve: 'continuous', backgroundColor: 'rgba(12,17,28,0.94)', borderWidth: 1, borderColor: C.border,
  },
  cardBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12,
    borderRadius: R.control, borderCurve: 'continuous', marginTop: 4,
  },
});
