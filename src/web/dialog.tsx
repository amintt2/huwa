// Web dialog: centered card from 768 px, bottom sheet below. Escape and a click on the backdrop
// close it; focus moves into it on open. Enters with a short ease-out (scale 0.97 → 1 and fade on
// desktop, slide-up on phones) and leaves faster; no motion when the user asks for less.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { C, DUR, EASE_OUT, R, S, SHADOW } from '@/theme/tokens';

import { WIDE, useWindowSize } from './viewport';

const ease = Easing.bezier(...EASE_OUT);

export function WebDialog({
  visible,
  onClose,
  children,
  label,
  width = 440,
  /** Render in place (inside a transparent route) instead of a portal Modal. */
  inline,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  label: string;
  width?: number;
  inline?: boolean;
}) {
  const { width: w } = useWindowSize();
  const wide = w >= WIDE;
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const t = useSharedValue(0);
  const [mounted, setMounted] = useState(visible);
  const card = useRef<View>(null);

  // Mount as soon as it opens (during render); unmount after the exit animation.
  if (visible && !mounted) setMounted(true);
  useEffect(() => {
    if (visible) {
      t.set(withTiming(1, { duration: reduce ? 0 : DUR.enter, easing: ease }));
    } else if (mounted) {
      t.set(withTiming(0, { duration: reduce ? 0 : DUR.exit, easing: ease }));
      const timer = setTimeout(() => setMounted(false), reduce ? 0 : DUR.exit);
      return () => clearTimeout(timer);
    }
  }, [visible, mounted, reduce, t]);

  useEffect(() => {
    if (!visible || typeof document === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Focus the dialog itself so Tab starts inside it and screen readers announce it.
    const el = card.current as unknown as HTMLElement | null;
    el?.focus?.();
    return () => document.removeEventListener('keydown', onKey);
  }, [visible, onClose]);

  const backdrop = useAnimatedStyle(() => ({ opacity: t.get() }));
  const panel = useAnimatedStyle(() =>
    wide
      ? { opacity: t.get(), transform: [{ scale: 0.97 + 0.03 * t.get() }] }
      : { transform: [{ translateY: (1 - t.get()) * 420 }] },
  );

  if (!mounted) return null;

  const body = (
    <View style={[StyleSheet.absoluteFill, wide ? styles.center : styles.bottom]}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdrop]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Fermer" accessibilityRole="button" tabIndex={-1} />
      </Animated.View>
      <Animated.View
        ref={card}
        role="dialog"
        aria-modal
        aria-label={label}
        tabIndex={-1}
        style={[
          styles.card,
          wide ? { width, maxWidth: '92%', borderRadius: R.sheet } : { width: '100%', borderTopLeftRadius: R.sheet, borderTopRightRadius: R.sheet, paddingBottom: S.xl + insets.bottom },
          panel,
        ]}>
        {!wide && <View style={styles.grabber} />}
        {children}
      </Animated.View>
    </View>
  );

  if (inline) return body;
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      {body}
    </Modal>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', padding: S.lg },
  bottom: { justifyContent: 'flex-end' },
  backdrop: { backgroundColor: 'rgba(2,4,9,0.72)' },
  card: {
    backgroundColor: C.sheet, borderWidth: 1, borderColor: C.border, padding: S.xl, gap: S.lg,
    boxShadow: `${SHADOW.sheet}, ${SHADOW.inset}`, outlineStyle: 'none',
  } as object,
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: C.borderStrong, marginTop: -S.sm },
});
