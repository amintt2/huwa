// Preloads the next episode while the current one plays, so "Épisode suivant" starts at once:
// 1. addon sources (and subtitles) are fetched into the shared cache used by the next screen,
// 2. the best source is resolved (debrid link / native torrent engine starts on its first pieces),
// 3. a hidden, muted, paused player opens it and buffers its first seconds (skipped when the
//    network policy forbids streaming, e.g. "Wi-Fi seulement" on cellular). It lives in the warm
//    pool (./warm-pool.ts): the next watch screen takes that very player over, buffer included.
// Hosted player pages (web player) are never preloaded: only their sources are resolved
// (`src.url` stays empty for them).
import { useSubtitles } from '@/addons/registry';
import { useSource } from '@/addons/use-source';

import { WarmPlayer } from './warm-player';

export function PrefetchNext({ seriesId, episode, armed, buffer }: { seriesId: string; episode: number; armed: boolean; buffer: boolean }) {
  const src = useSource(seriesId, episode, { enabled: armed });
  useSubtitles(seriesId, episode, armed);
  if (!armed || !buffer || !src.url) return null;
  return <WarmPlayer key={src.url} uri={src.url} headers={src.headers} />;
}
