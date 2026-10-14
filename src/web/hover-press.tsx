// Pressable card for pointer and keyboard. Hover: the card lifts 4 px and its art gets a soft ring
// (purpose: show what a click opens, in a grid where everything looks clickable). Focus: a 2 px
// accent outline, visible only for keyboard focus. Press: scale 0.96.
// CSS transitions with the ease-out of the design tokens; nothing moves with Reduce Motion.
import type { ReactNode } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { C } from '@/theme/tokens';

type WebState = { hovered?: boolean; focused?: boolean; pressed: boolean };

const TRANSITION = {
  transitionProperty: 'transform, box-shadow, opacity',
  transitionDuration: '180ms',
  transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
} as object;

const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function HoverPress({
  style,
  children,
  lift = 4,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & { style?: StyleProp<ViewStyle>; children: ReactNode | ((s: { hovered: boolean; focused: boolean }) => ReactNode); lift?: number }) {
  return (
    <Pressable
      {...rest}
      style={(st) => {
        const s = st as WebState;
        const up = !reduceMotion && (s.hovered || s.focused) && !s.pressed ? -lift : 0;
        const scale = !reduceMotion && s.pressed ? 0.96 : 1;
        return [
          TRANSITION,
          { borderRadius: 12, transform: [{ translateY: up }, { scale }] },
          s.focused && ({ outlineColor: C.accentText, outlineWidth: 2, outlineStyle: 'solid', outlineOffset: 3 } as object),
          style,
        ];
      }}>
      {(st) => {
        const s = st as WebState;
        return typeof children === 'function' ? children({ hovered: !!s.hovered, focused: !!s.focused }) : children;
      }}
    </Pressable>
  );
}

/** Ring drawn over the art of a hovered card (place it last inside the Cover). */
export const hoverRing = (on: boolean): ViewStyle => ({
  position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 10, borderWidth: 2,
  borderColor: on ? 'rgba(127,176,255,0.85)' : 'transparent',
  ...(TRANSITION as ViewStyle),
});
