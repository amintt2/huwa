// Plugs the native engine into the torrent resolution chain (src/debrid/resolve.ts): a configured
// debrid service is tried first (instant for cached torrents), then the on-device engine.
// Registered only while the engine is linked AND switched on in Téléchargements.
import { registerTorrentResolver } from '@/debrid/resolve';

import { isAvailable, resolveTorrent } from './index';
import { getTorrentSettings, hydrateTorrentSettings, subscribeTorrentSettings } from './settings';

let unregister: (() => void) | undefined;

const enabled = () => isAvailable() && getTorrentSettings().enabled;

function sync() {
  if (enabled() && !unregister) {
    unregister = registerTorrentResolver({
      id: 'huwa-torrent',
      label: 'moteur Huwa',
      available: enabled,
      // The loopback URL only lives as long as the torrent in the engine: resolve each time.
      cacheMs: 0,
      resolve: async (t) => {
        const handle = await resolveTorrent({ infoHash: t.infoHash, fileIdx: t.fileIdx, sources: t.sources, name: t.filename });
        if (!handle) throw new Error('Moteur torrent désactivé');
        return handle.url;
      },
    });
  } else if (!enabled() && unregister) {
    unregister();
    unregister = undefined;
  }
}

let started = false;
export function registerNativeTorrentEngine() {
  if (started) return;
  started = true;
  hydrateTorrentSettings().then(sync);
  subscribeTorrentSettings(sync);
}
