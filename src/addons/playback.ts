// Does this install have a way to play episodes / read chapters inside Huwa?
// Without one, episodes and chapters open the « Où regarder / Où lire » screen (official services)
// instead of an empty player or a reader of placeholder pages: nothing suggests content Huwa
// does not have. The built-in « Où regarder » extension does not count: it serves no stream.
import { isStoreBuild } from '@/config/channel';
import { useMangaExt } from '@/manga-ext/registry';

import { resourceNames } from './protocol';
import { BUILTIN_ID, useAddons, useAddonsHydrated } from './registry';

/** true / false, or undefined while the saved extension list is loading. */
export function useCanWatch(): boolean | undefined {
  const addons = useAddons();
  const hydrated = useAddonsHydrated();
  if (isStoreBuild) return false;
  if (!hydrated) return undefined;
  return addons.some((a) => a.enabled && a.manifest.id !== BUILTIN_ID && resourceNames(a.manifest).includes('stream'));
}

export function useCanRead(): boolean {
  const { installed } = useMangaExt();
  if (isStoreBuild) return false;
  return installed.some((s) => s.enabled);
}
