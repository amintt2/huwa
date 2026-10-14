// Hover lift for cards that already handle their own press (the native `Press` cards): the
// wrapper only moves; clicks, focus and labels stay on the card inside.
import { useState, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function Lift({ children, style, by = 4 }: { children: ReactNode; style?: StyleProp<ViewStyle>; by?: number }) {
  const [on, setOn] = useState(false);
  const events = { onMouseEnter: () => setOn(true), onMouseLeave: () => setOn(false), onFocus: () => setOn(true), onBlur: () => setOn(false) };
  return (
    <View
      {...(events as object)}
      style={[
        {
          transform: [{ translateY: on && !reduceMotion ? -by : 0 }],
          transitionProperty: 'transform',
          transitionDuration: '180ms',
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
        } as ViewStyle,
        style,
      ]}>
      {children}
    </View>
  );
}
