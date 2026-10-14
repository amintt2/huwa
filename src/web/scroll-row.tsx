// Horizontal row for mouse and keyboard: the phone rails scroll with a swipe, a desktop has no
// such gesture (and Shift+wheel is undiscoverable). Chevron buttons appear on hover at each end
// that still has content and page by ~85 % of the visible width; keyboard users Tab through the
// cards, and the browser scrolls the focused one into view.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from 'react-native';

import { C, S } from '@/theme/tokens';

type WebState = { hovered?: boolean; focused?: boolean; pressed: boolean };

export function ScrollRow({
  children,
  gap = S.md,
  padding = S.lg,
  contentStyle,
  label,
}: {
  children: ReactNode;
  gap?: number;
  padding?: number;
  contentStyle?: StyleProp<ViewStyle>;
  /** Accessible name of the row ("Prochaines sorties"). */
  label?: string;
}) {
  const ref = useRef<ScrollView>(null);
  const [hover, setHover] = useState(false);
  const [x, setX] = useState(0);
  const [view, setView] = useState(0);
  const [content, setContent] = useState(0);

  const canLeft = x > 4;
  const canRight = x + view < content - 4;
  const page = (dir: 1 | -1) => ref.current?.scrollTo({ x: Math.max(0, x + dir * Math.max(200, view * 0.85)), animated: true });

  return (
    <View
      {...({ onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) } as object)}
      role="group"
      aria-label={label}>
      <ScrollView
        ref={ref}
        horizontal
        showsHorizontalScrollIndicator={false}
        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => setX(e.nativeEvent.contentOffset.x)}
        scrollEventThrottle={32}
        onLayout={(e: LayoutChangeEvent) => setView(e.nativeEvent.layout.width)}
        onContentSizeChange={(w) => setContent(w)}
        contentContainerStyle={[{ paddingHorizontal: padding, gap }, contentStyle]}>
        {children}
      </ScrollView>
      {canLeft && <Chevron dir={-1} visible={hover} onPress={() => page(-1)} />}
      {canRight && <Chevron dir={1} visible={hover} onPress={() => page(1)} />}
    </View>
  );
}

function Chevron({ dir, visible, onPress }: { dir: 1 | -1; visible: boolean; onPress: () => void }) {
  return (
    <View pointerEvents="box-none" style={[styles.edge, dir < 0 ? { left: 0 } : { right: 0 }]}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={dir < 0 ? 'Défiler vers la gauche' : 'Défiler vers la droite'}
        // Pointer-only affordance: keyboard users move with Tab.
        tabIndex={-1}
        style={(st) => {
          const s = st as WebState;
          return [styles.chevron, { opacity: visible ? 1 : 0 }, s.hovered && styles.chevronHover, s.pressed && { transform: [{ scale: 0.94 }] }];
        }}>
        <Ionicons name={dir < 0 ? 'chevron-back' : 'chevron-forward'} size={22} color={C.text} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  edge: { position: 'absolute', top: 0, bottom: 0, width: 64, justifyContent: 'center', alignItems: 'center' },
  chevron: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(12,17,28,0.88)', borderWidth: 1, borderColor: C.borderStrong,
    boxShadow: '0px 4px 16px rgba(0,0,0,0.5)',
    transitionProperty: 'opacity, background-color, transform', transitionDuration: '160ms', transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
  } as object,
  chevronHover: { backgroundColor: C.elevated },
});
