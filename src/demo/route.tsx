// Opens `-HuwaRoute` once the navigator is mounted (demo mode only, see ./flags).
// Several screens can be stacked with `|`, e.g. `/watch/void-e12|/comments?target=…`: each is
// pushed after the previous transition has settled (sheets lay out correctly over a screen).
import { router, useRootNavigationState, type Href } from 'expo-router';
import { useEffect, useRef } from 'react';

import { demoRoute } from './flags';

export function DemoRoute() {
  const navReady = !!useRootNavigationState()?.key;
  const done = useRef(false);
  useEffect(() => {
    if (!navReady || done.current || !demoRoute) return;
    done.current = true;
    const steps = demoRoute.split('|').filter((r) => r && r !== '/');
    const timers = steps.map((r, i) => setTimeout(() => router.push(r as Href), 150 + i * 1200));
    return () => timers.forEach(clearTimeout);
  }, [navReady]);
  return null;
}
