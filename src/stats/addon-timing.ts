// Response time / success of the stream addons, for "Statistiques de lecture" (on-device only).
// Keyed by the addon's manifest id and shown with its name; the addon URL (which may carry a
// personal configuration or key) is never recorded.
import { recordAddon } from './store';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export async function timedAddon<T>(manifest: { id: string; name: string }, run: () => Promise<T>): Promise<T> {
  const t0 = now();
  try {
    const out = await run();
    recordAddon(manifest.id, manifest.name, now() - t0, true);
    return out;
  } catch (e) {
    // Cancelled (screen left): not the addon's fault.
    if (!(e instanceof Error && e.name === 'AbortError')) recordAddon(manifest.id, manifest.name, now() - t0, false);
    throw e;
  }
}
