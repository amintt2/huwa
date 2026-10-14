// Content viewport of the web shell (docs/WEB_DOCKER_PLAN.md §3, "NativeTabs → left rail").
//
// The screens were written for a phone and size themselves with `useWindowDimensions()`. On the
// web the shell takes part of the window (left rail, top bar, bottom bar), so the window size is
// wrong for them: a 1280 px hero next to an 80 px rail overflows by 80 px. metro.config.js swaps
// react-native-web's `useWindowDimensions` for `useContentDimensions` below
// (src/web/use-window-dimensions.ts): app code gets the size of the area it renders in.
//
// This module must not import `useWindowDimensions` from 'react-native' (it would be itself).
import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';

export type ChromeInsets = { left: number; top: number; bottom: number };

type Size = { width: number; height: number };
type Dims = { width: number; height: number; scale: number; fontScale: number };

const NONE: ChromeInsets = { left: 0, top: 0, bottom: 0 };

let insets: ChromeInsets = NONE;
let windowSize: Size = readWindow();
let content: Dims = compute();
const listeners = new Set<() => void>();

function readWindow(): Size {
  if (typeof document === 'undefined') return { width: 1024, height: 768 };
  // Same source as react-native-web's Dimensions ('window').
  const el = document.documentElement;
  return { width: el.clientWidth || window.innerWidth, height: el.clientHeight || window.innerHeight };
}

function compute(): Dims {
  return {
    width: Math.max(0, windowSize.width - insets.left),
    height: Math.max(0, windowSize.height - insets.top - insets.bottom),
    scale: typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
    fontScale: 1,
  };
}

function emit() {
  const next = compute();
  if (next.width === content.width && next.height === content.height && next.scale === content.scale) return;
  content = next;
  listeners.forEach((l) => l());
}

const windowListeners = new Set<() => void>();

function onResize() {
  const next = readWindow();
  if (next.width === windowSize.width && next.height === windowSize.height) return;
  windowSize = next;
  emit();
  windowListeners.forEach((l) => l());
}

if (typeof window !== 'undefined') window.addEventListener('resize', onResize);

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function subscribeWindow(l: () => void) {
  windowListeners.add(l);
  return () => {
    windowListeners.delete(l);
  };
}

/** Called by the shell when its chrome changes (breakpoint, full-screen routes). */
export function setChromeInsets(next: ChromeInsets) {
  if (next.left === insets.left && next.top === insets.top && next.bottom === insets.bottom) return;
  insets = next;
  emit();
}

export const chromeInsets = () => insets;

/**
 * Maximum width of a centered column (detail pages on a wide screen): screens inside lay out for
 * the column, not for the whole content area. 0 = no cap.
 */
export const ViewportCap = createContext(0);

/** Size of the area the screens render in: the window minus the shell's chrome. */
export function useContentDimensions(): Dims {
  const dims = useSyncExternalStore(subscribe, () => content, () => content);
  const cap = useContext(ViewportCap);
  return useMemo(() => (cap && dims.width > cap ? { ...dims, width: cap } : dims), [dims, cap]);
}

/** The real window size, for the shell itself (breakpoints). */
export function useWindowSize(): Size {
  return useSyncExternalStore(subscribeWindow, () => windowSize, () => windowSize);
}

/** Left rail + top bar from this width on; bottom bar below (Stremio Web uses the same split). */
export const WIDE = 768;
