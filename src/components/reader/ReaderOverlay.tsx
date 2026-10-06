// Reader overlay, shown on a tap (Paperback-style): a floating title card with close, a page
// scrubber on the edge, round actions at the bottom (comments, orientation lock, settings) and
// the previous / next chapter shortcuts. Fades and slides in; Reduce Motion → fade only.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { IconButton, Press, Txt, type IconName } from '@/components/ui';
import { C, DUR, EASE_OUT, F, R, S, SHADOW } from '@/theme/tokens';

import { Scrubber, SCRUBBER_W } from './Scrubber';

const ease = Easing.bezier(...EASE_OUT);

export type OverlayProps = {
  visible: boolean;
  insets: { top: number; bottom: number; left: number; right: number };
  width: number;
  height: number;
  title: string;
  subtitle: string;
  page: number;
  count: number;
  onPick: (page: number) => void;
  hand: 'right' | 'left';
  onClose: () => void;
  prev?: number;
  next?: number;
  onPrev: () => void;
  onNext: () => void;
  comments: number;
  onComments: () => void;
  download?: { icon: IconName | null; label: string; progress?: string; done: boolean; onPress: () => void };
  locked: boolean;
  onToggleLock: () => void;
  onSettings: () => void;
  toast?: string;
  onDismissToast: () => void;
  alwaysPage: boolean;
};

export function ReaderOverlay(p: OverlayProps) {
  const reduce = useReducedMotion();
  const shown = useSharedValue(p.visible ? 1 : 0);
  useEffect(() => {
    shown.set(withTiming(p.visible ? 1 : 0, { duration: p.visible ? DUR.enter : DUR.exit, easing: ease }));
  }, [p.visible, shown]);

  const topStyle = useAnimatedStyle(() => ({
    opacity: shown.get(),
    transform: [{ translateY: reduce ? 0 : (1 - shown.get()) * -16 }],
  }));
  const bottomStyle = useAnimatedStyle(() => ({
    opacity: shown.get(),
    transform: [{ translateY: reduce ? 0 : (1 - shown.get()) * 16 }],
  }));
  const sideStyle = useAnimatedStyle(() => ({
    opacity: shown.get(),
    transform: [{ translateX: reduce ? 0 : (1 - shown.get()) * (p.hand === 'right' ? 14 : -14) }],
  }));
  const pillStyle = useAnimatedStyle(() => ({ opacity: 1 - shown.get() }));

  const pe = p.visible ? 'box-none' : 'none';
  const edge = p.hand === 'right' ? { right: Math.max(p.insets.right, S.md) } : { left: Math.max(p.insets.left, S.md) };
  const otherEdge = p.hand === 'right' ? { left: Math.max(p.insets.left, S.md) } : { right: Math.max(p.insets.right, S.md) };
  const landscape = p.width > p.height;
  const cardW = Math.min(p.width - Math.max(p.insets.left, S.md) - Math.max(p.insets.right, S.md), 560);
  const topY = (landscape ? Math.max(p.insets.top, S.md) : p.insets.top + S.xs);
  const bottomY = Math.max(p.insets.bottom, S.md) + S.sm;
  // Scrubber between the card and the round buttons (3 × 44 + gaps).
  const scrubTop = topY + 76;
  const scrubH = Math.max(120, Math.min(380, p.height - scrubTop - bottomY - 3 * 44 - 3 * S.md - S.lg));

  return (
    <>
      {p.alwaysPage && p.count > 0 && (
        <Animated.View pointerEvents="none" style={[styles.pagePill, { bottom: Math.max(p.insets.bottom - 14, 4) }, pillStyle]}>
          <Txt v="footnote" tabular color={C.white} style={F.semibold}>{`${p.page + 1} / ${p.count}`}</Txt>
        </Animated.View>
      )}

      <Animated.View pointerEvents={pe} style={[styles.top, { top: topY, width: cardW, left: (p.width - cardW) / 2 }, topStyle]}>
        <View style={styles.card}>
          <View style={{ flex: 1, gap: 1 }}>
            <Txt v="headline" numberOfLines={1} style={{ fontSize: 16 }}>{p.title}</Txt>
            <Txt v="footnote" numberOfLines={1}>{p.subtitle}</Txt>
          </View>
          {p.download && (
            <Press onPress={p.download.onPress} style={styles.cardBtn} accessibilityRole="button" accessibilityLabel={p.download.label} hitSlop={6}>
              {p.download.icon ? (
                <Ionicons name={p.download.icon} size={20} color={p.download.done ? C.accentText : C.text} />
              ) : (
                <Txt v="caption" tabular color={C.accentText} style={{ fontSize: 10 }}>{p.download.progress}</Txt>
              )}
            </Press>
          )}
          <Press onPress={p.onClose} style={styles.cardBtn} accessibilityRole="button" accessibilityLabel="Fermer le lecteur" hitSlop={6}>
            <Ionicons name="close" size={20} color={C.text} />
          </Press>
        </View>
        {p.toast && (
          <Press onPress={p.onDismissToast} style={styles.toast} accessibilityRole="button" accessibilityLabel={`${p.toast}. Masquer`}>
            <Ionicons name="tv-outline" size={13} color={C.white} />
            <Txt v="footnote" color={C.white}>{p.toast}</Txt>
            <Ionicons name="close" size={13} color={C.white} />
          </Press>
        )}
      </Animated.View>

      {p.count > 1 && (
        <Animated.View pointerEvents={pe} style={[styles.abs, edge, { top: scrubTop }, sideStyle]}>
          <Scrubber page={p.page} count={p.count} height={scrubH} onPick={p.onPick} />
        </Animated.View>
      )}

      <Animated.View pointerEvents={pe} style={[styles.abs, styles.column, edge, { bottom: bottomY, width: Math.max(44, SCRUBBER_W) }, bottomStyle]}>
        <IconButton icon="chatbubble-outline" label={`${p.comments} commentaires sur ce chapitre`} onPress={p.onComments}
          right={p.comments > 0 ? (
            <View style={styles.badge} pointerEvents="none">
              <Txt v="caption" tabular color={C.white} style={{ fontSize: 10, letterSpacing: 0 }}>{p.comments > 99 ? '99+' : p.comments}</Txt>
            </View>
          ) : undefined} />
        <IconButton icon={p.locked ? 'lock-closed' : 'phone-portrait-outline'} color={p.locked ? C.accentText : C.text}
          label={p.locked ? 'Orientation verrouillée, déverrouiller' : 'Orientation libre, verrouiller'} onPress={p.onToggleLock} />
        <IconButton icon="settings-outline" label="Réglages du lecteur" onPress={p.onSettings} />
      </Animated.View>

      <Animated.View pointerEvents={pe} style={[styles.abs, styles.nav, otherEdge, { bottom: bottomY }, bottomStyle]}>
        <Press onPress={p.onPrev} disabled={p.prev === undefined} style={[styles.navBtn, p.prev === undefined && { opacity: 0.4 }]}
          accessibilityRole="button" accessibilityLabel={p.prev !== undefined ? `Chapitre précédent, ${p.prev}` : 'Pas de chapitre précédent'}>
          <Ionicons name="chevron-back" size={16} color={C.text} />
          <Txt v="small" tabular color={C.text} style={F.semibold}>{p.prev !== undefined ? `Ch. ${p.prev}` : 'Début'}</Txt>
        </Press>
        <View style={styles.navSep} />
        <Press onPress={p.onNext} disabled={p.next === undefined} style={[styles.navBtn, p.next === undefined && { opacity: 0.4 }]}
          accessibilityRole="button" accessibilityLabel={p.next !== undefined ? `Chapitre suivant, ${p.next}` : 'Pas de chapitre suivant'}>
          <Txt v="small" tabular color={C.text} style={F.semibold}>{p.next !== undefined ? `Ch. ${p.next}` : 'À jour'}</Txt>
          <Ionicons name="chevron-forward" size={16} color={C.text} />
        </Press>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  abs: { position: 'absolute' },
  top: { position: 'absolute', gap: S.sm },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingLeft: S.lg, paddingRight: S.sm, paddingVertical: S.sm, minHeight: 60,
    borderRadius: 20, borderCurve: 'continuous', backgroundColor: 'rgba(22,28,42,0.88)', borderWidth: 1, borderColor: C.glassLine,
    boxShadow: SHADOW.float,
  },
  cardBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)' },
  toast: {
    alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, paddingHorizontal: 12,
    borderRadius: R.pill, backgroundColor: C.accent, boxShadow: SHADOW.float,
  },
  column: { gap: S.md, alignItems: 'center' },
  badge: {
    position: 'absolute', top: -4, right: -6, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9,
    backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: C.bg,
  },
  nav: {
    flexDirection: 'row', alignItems: 'center', height: 44, borderRadius: R.pill, backgroundColor: C.glass,
    borderWidth: 1, borderColor: C.glassLine, boxShadow: SHADOW.float, overflow: 'hidden',
  },
  navBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 44, paddingHorizontal: 14 },
  navSep: { width: StyleSheet.hairlineWidth, height: 22, backgroundColor: C.glassLine },
  pagePill: {
    position: 'absolute', alignSelf: 'center', paddingHorizontal: 10, paddingVertical: 3, borderRadius: R.pill,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
});
