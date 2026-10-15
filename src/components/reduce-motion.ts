// Live "Reduce Motion" setting, one listener for the whole app (Reanimated's `useReducedMotion`
// only reads it once at startup). On the web, react-native-web answers from
// `prefers-reduced-motion`.
import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

let reduced = false;
let started = false;
const listeners = new Set<() => void>();

function start() {
  if (started) return;
  started = true;
  const set = (v: boolean) => {
    if (v === reduced) return;
    reduced = v;
    listeners.forEach((l) => l());
  };
  AccessibilityInfo.isReduceMotionEnabled().then(set, () => {});
  AccessibilityInfo.addEventListener('reduceMotionChanged', set);
}

function subscribe(l: () => void) {
  start();
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const snapshot = () => reduced;

export function useReduceMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
