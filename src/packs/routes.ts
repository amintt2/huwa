// Where a pasted / scanned link leads, and a link kept for later (pasted during the introduction,
// opened once the app's navigator is mounted, always on its confirmation screen).
import type { Href } from 'expo-router';
import { useSyncExternalStore } from 'react';

import type { PastedLink } from './format';

export function hrefFor(link: PastedLink): Href {
  if (link.kind === 'pack') return { pathname: '/pack', params: 'd' in link.ref ? { d: link.ref.d } : { url: link.ref.url } } as unknown as Href;
  if (link.kind === 'paperback') return { pathname: '/manga-sources', params: { repo: link.url } } as unknown as Href;
  return { pathname: '/addon', params: { url: link.url } } as unknown as Href;
}

let pending: Href | undefined;
const listeners = new Set<() => void>();

export function setPendingLink(href: Href | undefined) {
  pending = href;
  listeners.forEach((l) => l());
}

export function usePendingLink() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
    () => pending,
  );
}
