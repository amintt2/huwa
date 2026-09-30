// Web player: the hosted player page an addon returned (`externalUrl`, or a `url` that is an
// HTML page), shown in a WebView where the native player sits (16:9, landscape = fullscreen).
// - no pop-ups / new windows, main frame kept on the player's site (ad redirects are refused)
// - web-bridge.ts reports the page's <video> time → progress saved, end → watched + next episode
//   countdown; resume position and AniSkip buttons seek it
// - when the video is out of reach (cross-origin iframe without the bridge), playback still
//   works and "Marquer comme vu" / "Épisode suivant" are offered instead
// - "Ouvrir dans le navigateur" as a fallback
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { BackHandler, Linking, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInLeft, SlideInRight, SlideOutLeft, SlideOutRight } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

import { hostOf, siteOf } from '@/addons/web-player';
import { Txt, type IconName } from '@/components/ui';
import { C, F, R, S } from '@/theme/tokens';

import { useSkipTimes } from './aniskip';
import { AUTO_NEXT_SECONDS, NextCard, Pill } from './overlays';
import type { PlayerHandle } from './Player';
import { getPrefs, setPrefs, usePrefs } from './prefs';
import { BRIDGE_SCRIPT, commandScript, parseBridgeMessage } from './web-bridge';

export type WebPlayerProps = {
  ref?: Ref<PlayerHandle>;
  url: string;
  title: string;
  subtitle?: string;
  startAt?: () => number | undefined;
  onProgress?: (position: number, duration: number) => void;
  onEnd?: () => void;
  /** The page could not be loaded (the parent can try another source). */
  onError?: (message: string) => void;
  next?: { label: string; onPlay: () => void } | null;
  malId?: number | null;
  episodeNumber?: number;
  notice?: string;
  onFullscreenChange?: (full: boolean) => void;
  onOpenSources?: () => void;
  sourceLabel?: string;
  renderComments?: () => ReactNode;
  commentCount?: number;
};

const NEXT_WINDOW = 90;
/** Without any report from the page after this long, the video is considered out of reach. */
const NO_ACCESS_AFTER = 8000;
// WKWebView's default user agent has no "Safari" token, which some hosts refuse.
const SAFARI_TOKEN = 'Version/18.0 Mobile/15E148 Safari/604.1';

const lockOrientation = (lock: ScreenOrientation.OrientationLock) => ScreenOrientation.lockAsync(lock).catch(() => {});

function Btn({ icon, label, onPress, active }: { icon: IconName; label: string; onPress: () => void; active?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => [styles.btn, active && { backgroundColor: C.accentSoft }, pressed && { opacity: 0.6 }]}>
      <Ionicons name={icon} size={19} color={active ? C.accentText : C.white} />
    </Pressable>
  );
}

export function WebPlayer({
  ref,
  url,
  title,
  subtitle,
  startAt,
  onProgress,
  onEnd,
  onError,
  next,
  malId,
  episodeNumber = 1,
  notice,
  onFullscreenChange,
  onOpenSources,
  sourceLabel,
  renderComments,
  commentCount,
}: WebPlayerProps) {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const prefs = usePrefs();
  const web = useRef<WebView>(null);
  const cb = useRef({ startAt, onProgress, onEnd, onError, next, onFullscreenChange });
  useEffect(() => {
    cb.current = { startAt, onProgress, onEnd, onError, next, onFullscreenChange };
  });

  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [reach, setReach] = useState<'waiting' | 'video' | 'none'>('waiting');
  const [ended, setEnded] = useState(false);
  const [watched, setWatched] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [blocked, setBlocked] = useState('');
  const [bar, setBar] = useState(true);
  const [barTouch, setBarTouch] = useState(0);
  const [commentsOpen, setCommentsOpen] = useState(false);

  // Page-side state kept out of render.
  const live = useRef({ frame: '', frameDur: 0, t: 0, d: 0, resumed: false, lastSave: 0, loaded: false, sites: new Set([siteOf(url)]) });

  // ---------- fullscreen = landscape (same behaviour as the native player) ----------
  const full = window.width > window.height;
  useEffect(() => {
    cb.current.onFullscreenChange?.(full);
  }, [full]);
  useEffect(() => {
    lockOrientation(ScreenOrientation.OrientationLock.DEFAULT);
    return () => {
      lockOrientation(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    };
  }, []);
  const exitFull = () => {
    setCommentsOpen(false);
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

  // Fullscreen toolbar hides itself; a small handle brings it back.
  useEffect(() => {
    if (!full || !bar || commentsOpen) return;
    const t = setTimeout(() => setBar(false), 4000);
    return () => clearTimeout(t);
  }, [full, bar, barTouch, commentsOpen]);
  const wake = () => {
    setBar(true);
    setBarTouch((n) => n + 1);
  };

  useEffect(() => {
    if (!blocked) return;
    const t = setTimeout(() => setBlocked(''), 2500);
    return () => clearTimeout(t);
  }, [blocked]);

  // No report from the page after a while: the video lives in a frame the bridge cannot reach.
  useEffect(() => {
    if (reach !== 'waiting') return;
    const t = setTimeout(() => setReach((r) => (r === 'waiting' ? 'none' : r)), NO_ACCESS_AFTER);
    return () => clearTimeout(t);
  }, [reach]);

  // Save on leave.
  useEffect(
    () => () => {
      const l = live.current;
      if (l.d > 0) cb.current.onProgress?.(l.t, l.d);
    },
    [],
  );

  // ---------- AniSkip ----------
  const { segments } = useSkipTimes(malId, episodeNumber, duration);
  const intro = segments.find((s) => s.kind === 'intro');
  const recap = segments.find((s) => s.kind === 'recap');
  const outro = segments.find((s) => s.kind === 'outro');
  const outroRef = useRef(outro);
  const countdownFired = useRef(false);
  useEffect(() => {
    outroRef.current = outro;
  }, [outro]);

  const seek = (t: number) => {
    const l = live.current;
    if (!l.frame) return;
    web.current?.injectJavaScript(commandScript('seek', Math.max(0, t), l.frame));
    setEnded(false);
    setCountdown(null);
  };

  useImperativeHandle(
    ref,
    () => ({
      getTime: () => live.current.t,
      seekTo: (t) => seek(t),
      play: () => live.current.frame && web.current?.injectJavaScript(commandScript('play', 0, live.current.frame)),
      pause: () => live.current.frame && web.current?.injectJavaScript(commandScript('pause', 0, live.current.frame)),
    }),
    [],
  );

  const startNextCountdown = () => {
    if (countdownFired.current || !cb.current.next || !getPrefs().autoNext) return;
    countdownFired.current = true;
    setCountdown(AUTO_NEXT_SECONDS);
  };

  const onMessage = (e: WebViewMessageEvent) => {
    const m = parseBridgeMessage(e.nativeEvent.data);
    if (!m) return;
    const l = live.current;
    // Several videos (e.g. an ad before the episode): follow the longest one.
    if (m.f !== l.frame) {
      if (l.frame && m.d < l.frameDur) return;
      l.frame = m.f;
    }
    l.frameDur = Math.max(l.frameDur, m.d);
    l.t = m.c;
    l.d = m.d;
    setReach('video');
    setTime(m.c);
    if (m.d > 0) setDuration(m.d);
    // Resume where the episode was left, once the page knows the duration.
    if (!l.resumed && m.d > 0) {
      l.resumed = true;
      const at = cb.current.startAt?.();
      if (at && at > 1 && at < m.d - 5) seek(at);
    }
    if (m.t === 'ended') {
      setEnded(true);
      setWatched(true);
      cb.current.onProgress?.(m.d, m.d);
      cb.current.onEnd?.();
      startNextCountdown();
      return;
    }
    const o = outroRef.current;
    if (o && m.c >= o.start && m.c < o.end && !m.p) startNextCountdown();
    if (m.d > 0 && Date.now() - l.lastSave >= 5000) {
      l.lastSave = Date.now();
      cb.current.onProgress?.(m.c, m.d);
    }
  };

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

  // ---------- navigation guard ----------
  const onShouldStart = (r: ShouldStartLoadRequest) => {
    if (!/^https?:/i.test(r.url)) return /^(about|data|blob):/i.test(r.url);
    // Frames inside the page load what they want; only the page itself is pinned.
    if (r.isTopFrame === false) return true;
    const l = live.current;
    const site = siteOf(r.url);
    if (l.sites.has(site)) return true;
    // Server redirects of the player URL before it first loads (mirror domains).
    if (!l.loaded) {
      l.sites.add(site);
      return true;
    }
    setBlocked(`Redirection bloquée (${hostOf(r.url)})`);
    return false;
  };

  const markWatched = () => {
    setWatched(true);
    cb.current.onEnd?.();
  };
  const openBrowser = () => Linking.openURL(url).catch(() => {});

  // ---------- skip buttons (video reachable) ----------
  const inSeg = (s?: { start: number; end: number }) => !!s && time >= s.start && time < s.end - 1;
  const skipBtn: { key: string; label: string; to: number } | null = reach !== 'video' || ended ? null
    : intro && inSeg(intro) && !skipped.includes('intro') ? { key: 'intro', label: 'Passer l’intro', to: intro.end }
    : recap && inSeg(recap) && !skipped.includes('recap') ? { key: 'recap', label: 'Passer le récap', to: recap.end }
    : outro && inSeg(outro) && !skipped.includes('outro') && outro.end < duration - 3 ? { key: 'outro', label: 'Passer le générique', to: outro.end }
    : null;
  const showNext = reach === 'video' && !!next && !ended && countdown === null && duration > 60 && (outro ? time >= outro.start : duration - time <= NEXT_WINDOW);
  // Video out of reach: manual controls instead of progress tracking.
  const manual = reach === 'none';
  const sideInset = full ? Math.max(insets.left, insets.right, S.lg) : S.md;
  const panelW = Math.min(420, window.width * 0.42);
  const panelLeft = prefs.commentsSide === 'left';
  const host = hostOf(url);

  // Short labels in the portrait bar, full ones over the fullscreen video.
  const manualButtons = (short: boolean) => manual && (
    <>
      <Pressable onPress={markWatched} disabled={watched} accessibilityRole="button" accessibilityLabel="Marquer comme vu"
        style={({ pressed }) => [styles.small, pressed && { opacity: 0.7 }]}>
        <Ionicons name={watched ? 'checkmark-circle' : 'checkmark-circle-outline'} size={15} color={watched ? C.accentText : C.white} />
        <Text style={styles.smallText}>{watched ? 'Vu' : short ? 'Marquer vu' : 'Marquer comme vu'}</Text>
      </Pressable>
      {next && (
        <Pressable onPress={() => next.onPlay()} accessibilityRole="button" accessibilityLabel="Épisode suivant"
          style={({ pressed }) => [styles.small, { backgroundColor: C.accent }, pressed && { opacity: 0.8 }]}>
          <Ionicons name="play-skip-forward" size={14} color={C.white} />
          <Text style={styles.smallText}>{short ? 'Suivant' : 'Épisode suivant'}</Text>
        </Pressable>
      )}
    </>
  );

  return (
    <View style={full ? styles.full : undefined}>
      {full && <StatusBar hidden animated />}
      <View style={full ? [StyleSheet.absoluteFill, { paddingLeft: insets.left, paddingRight: insets.right }] : styles.inline}>
        <WebView
          ref={web}
          source={{ uri: url }}
          style={{ flex: 1, backgroundColor: C.black }}
          containerStyle={{ backgroundColor: C.black }}
          originWhitelist={['http://*', 'https://*', 'about:*', 'data:*', 'blob:*']}
          allowsInlineMediaPlayback
          allowsFullscreenVideo
          mediaPlaybackRequiresUserAction={false}
          allowsAirPlayForMediaPlayback
          allowsPictureInPictureMediaPlayback
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows={false}
          onOpenWindow={() => setBlocked('Pop-up bloquée')}
          onShouldStartLoadWithRequest={onShouldStart}
          applicationNameForUserAgent={Platform.OS === 'ios' ? SAFARI_TOKEN : undefined}
          injectedJavaScriptBeforeContentLoaded={BRIDGE_SCRIPT}
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}
          injectedJavaScript={BRIDGE_SCRIPT}
          injectedJavaScriptForMainFrameOnly={false}
          onMessage={onMessage}
          onLoadEnd={() => {
            live.current.loaded = true;
          }}
          onError={(e) => cb.current.onError?.(e.nativeEvent.description || 'Page du lecteur injoignable')}
          onHttpError={(e) => {
            if (e.nativeEvent.statusCode >= 400) cb.current.onError?.(`Lecteur web : HTTP ${e.nativeEvent.statusCode}`);
          }}
          allowsBackForwardNavigationGestures={false}
          pullToRefreshEnabled={false}
          bounces={false}
          setBuiltInZoomControls={false}
        />

        {!!(notice || blocked) && (
          <View pointerEvents="none" style={[styles.notice, { top: full ? S.lg : S.sm }]}>
            <Txt v="small" color={C.white}>{blocked || notice}</Txt>
          </View>
        )}

        {(skipBtn || showNext || (full && manual && bar)) && (
          <View pointerEvents="box-none" style={[styles.pillWrap, { bottom: full ? Math.max(insets.bottom, S.lg) + 56 : 52, right: sideInset }]}>
            {skipBtn && (
              <Pill icon="play-skip-forward" label={skipBtn.label} onPress={() => { seek(skipBtn.to); setSkipped((s) => [...s, skipBtn.key]); }} />
            )}
            {showNext && <Pill primary icon="play-skip-forward" label="Épisode suivant" onPress={() => next!.onPlay()} />}
            {full && manual && bar && manualButtons(false)}
          </View>
        )}

        {next && countdown !== null && (
          <NextCard label={next.label} countdown={countdown} onCancel={() => setCountdown(null)} onPlay={() => next.onPlay()}
            style={{ right: sideInset, bottom: full ? Math.max(insets.bottom, S.lg) + 8 : S.md }} />
        )}

        {full && (bar ? (
          <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(200)}
            style={[styles.fullBar, { top: Math.max(insets.top, S.sm), left: sideInset, right: sideInset }]}>
            <Btn icon="chevron-down" label="Quitter le plein écran" onPress={exitFull} />
            <View style={{ flexShrink: 1, gap: 1 }}>
              <Txt v="label" numberOfLines={1}>{title}</Txt>
              <Txt v="small" numberOfLines={1}>{subtitle ? `${subtitle} · ` : ''}Lecteur web · {host}</Txt>
            </View>
            <View style={{ flex: 1 }} />
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
            <Btn icon="open-outline" label="Ouvrir dans le navigateur" onPress={openBrowser} />
          </Animated.View>
        ) : (
          <Pressable onPress={wake} hitSlop={10} accessibilityRole="button" accessibilityLabel="Afficher les commandes"
            style={[styles.handle, { top: Math.max(insets.top, S.sm), left: sideInset }]}>
            <Ionicons name="ellipsis-horizontal" size={18} color={C.white} />
          </Pressable>
        ))}

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
      </View>

      {!full && (
        <View style={styles.bar}>
          <Ionicons name="globe-outline" size={15} color={C.text2} />
          {!manual && <Txt v="small" numberOfLines={1} style={{ flexShrink: 1 }}>Lecteur web · {host}</Txt>}
          <View style={{ flex: 1 }} />
          {manualButtons(true)}
          <Btn icon="open-outline" label="Ouvrir dans le navigateur" onPress={openBrowser} />
          <Btn icon="expand" label="Plein écran" onPress={() => lockOrientation(ScreenOrientation.OrientationLock.LANDSCAPE)} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  inline: { width: '100%', aspectRatio: 16 / 9, backgroundColor: C.black, overflow: 'hidden' },
  full: { flex: 1, backgroundColor: C.black, overflow: 'hidden' },
  bar: { flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingLeft: S.md, paddingRight: S.xs, height: 44, backgroundColor: C.black },
  btn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  small: {
    flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingHorizontal: 10,
    borderRadius: R.pill, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
  },
  smallText: { color: C.white, fontSize: 12, ...F.semibold },
  fullBar: {
    position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: S.sm, padding: 4, paddingRight: S.sm,
    borderRadius: R.card, backgroundColor: 'rgba(5,7,13,0.72)',
  },
  handle: {
    position: 'absolute', width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(5,7,13,0.5)',
  },
  chipBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, maxWidth: 180, paddingHorizontal: 12,
    borderRadius: R.pill, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)',
  },
  chipText: { color: C.white, fontSize: 12, ...F.semibold },
  notice: { position: 'absolute', alignSelf: 'center', paddingHorizontal: S.md, paddingVertical: 6, borderRadius: R.pill, backgroundColor: 'rgba(0,0,0,0.7)' },
  pillWrap: { position: 'absolute', flexDirection: 'row', gap: S.sm },
  panel: {
    position: 'absolute', top: 0, bottom: 0, backgroundColor: 'rgba(8,11,18,0.82)',
    borderColor: 'rgba(255,255,255,0.08)', borderLeftWidth: 1, borderRightWidth: 1,
  },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingTop: S.lg, paddingBottom: S.sm },
});
