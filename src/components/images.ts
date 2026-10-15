// Poster URLs sized for their slot, and prefetching of what is about to scroll into view.
//
// AniList serves each cover in up to three sizes under the same name: /cover/small/ (~100 px wide,
// `medium` in the API), /cover/medium/ (~230 px, `large`) and /cover/large/ (~460 px,
// `extraLarge`). Screens ask for `extraLarge` and each slot steps down to /cover/medium/ when that
// is still sharp at the screen's pixel density: a 48 pt thumbnail doesn't download a 460 px
// poster. Never up: old covers have no /cover/large/ file (their `extraLarge` is /cover/medium/).
import { Image } from 'expo-image';
import { useEffect } from 'react';
import { PixelRatio } from 'react-native';

const EXTRA_LARGE = /(\/anilistcdn\/media\/(?:anime|manga)\/cover\/)large\//;
/** Widest rendering (px) the ~230 px size covers without visible softening. */
const MEDIUM_MAX_PX = 250;

/** The AniList cover size for a slot `widthPt` points wide (other URLs are returned as is). */
export function sizedImage(url: string | undefined, widthPt?: number): string | undefined {
  if (!url || !widthPt || !EXTRA_LARGE.test(url)) return url;
  return widthPt * PixelRatio.get() <= MEDIUM_MAX_PX ? url.replace(EXTRA_LARGE, '$1medium/') : url;
}

const requested = new Set<string>();
const MAX_REMEMBERED = 2000;

/** Starts downloading images into the memory + disk cache (each URL once per session). */
export function prefetchImages(urls: (string | undefined)[], widthPt?: number) {
  const list: string[] = [];
  for (const u of urls) {
    const sized = sizedImage(u, widthPt);
    if (!sized || requested.has(sized)) continue;
    requested.add(sized);
    list.push(sized);
  }
  if (requested.size > MAX_REMEMBERED) requested.clear();
  if (list.length) Image.prefetch(list, 'memory-disk').catch(() => false);
}

/**
 * Prefetches `urls` shortly after the screen has painted (what is on screen already loads first:
 * this is for the rest of the rows, and the next ones).
 */
export function useImagePrefetch(urls: (string | undefined)[], widthPt?: number, delayMs = 300) {
  const key = urls.join('|');
  useEffect(() => {
    if (!key) return;
    const timer = setTimeout(() => prefetchImages(key.split('|'), widthPt), delayMs);
    return () => clearTimeout(timer);
  }, [key, widthPt, delayMs]);
}
