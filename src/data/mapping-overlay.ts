// Catalog transform that makes the bridge franchise-aware: a season's episodes adapt the
// chapters right after its prequels (data/franchise.ts), community-verified values
// (data/mapping-store.ts) replace the estimate, and a season without its own manhwa link uses
// the one of an earlier season. Every screen reads series through `getSeries`, so the bridge
// helpers (data/bridge.ts) see the result without knowing about seasons.
import { setSeriesTransform } from './catalog';
import { loadFranchise, prequelIdsOf } from './franchise';
import { applyMapping } from './mapping-apply';
import { hydrateMapping, overrideOf } from './mapping-store';

export { mappingRoom } from './mapping-apply';

let installed: Promise<void> | null = null;

/** Install the transform and restore persisted chains / community values (once). */
export function installMappingOverlay() {
  installed ??= (async () => {
    setSeriesTransform((s, base) => applyMapping(s, base, prequelIdsOf(s.id), overrideOf));
    await Promise.all([hydrateMapping(), loadFranchise()]);
  })();
  return installed;
}
