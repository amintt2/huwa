// Web build of ./skeleton (same props): the sweep is one CSS animation on a `::after` band instead
// of a Reanimated loop per block (no JS per frame), and `prefers-reduced-motion` turns it off in
// CSS. The style sheet is injected once.
import { View } from 'react-native';

import { C, R } from '@/theme/tokens';

import type { SkeletonProps } from './skeleton';

export const SWEEP_MS = 1400;
/** `delay` on the web: one CSS value (an attribute selector, no per-element style). */
const DELAYED_MS = 300;

// No `position` here: react-native-web views are already `relative` (or `absolute` when filled),
// and an attribute rule could override the atomic class of an absolutely positioned block.
const CSS = `@keyframes huwa-shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
[data-skeleton]::after{content:"";position:absolute;inset:0;pointer-events:none;transform:translateX(-100%);
background:linear-gradient(90deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.055) 50%,rgba(255,255,255,0) 100%);
animation:huwa-shimmer ${SWEEP_MS}ms cubic-bezier(.4,0,.2,1) infinite}
[data-skeleton=delayed]::after{animation-delay:${DELAYED_MS}ms}
@media (prefers-reduced-motion:reduce){[data-skeleton]::after{animation:none;display:none}}`;

if (typeof document !== 'undefined' && !document.getElementById('huwa-skeleton-css')) {
  const el = document.createElement('style');
  el.id = 'huwa-skeleton-css';
  el.textContent = CSS;
  document.head.appendChild(el);
}

// `dataSet` becomes data-* attributes in react-native-web (not in the React Native types).
const MARK = { dataSet: { skeleton: '' } } as object;
const MARK_DELAYED = { dataSet: { skeleton: 'delayed' } } as object;

export function Skeleton({ width = '100%', height, radius = R.control, tint = C.surface, style, children, delay }: SkeletonProps) {
  return (
    <View
      {...(delay ? MARK_DELAYED : MARK)}
      aria-hidden
      style={[{ width, height, borderRadius: radius, backgroundColor: tint, overflow: 'hidden' }, style]}>
      {children}
    </View>
  );
}
