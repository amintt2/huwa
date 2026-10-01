// After a data import, every store already loaded in memory must re-read AsyncStorage, otherwise
// its stale state is shown and written back over the imported values on the next change (or by a
// pending debounced save). Stores register here when their module loads; modules not loaded yet
// will read the imported values when they are.
type Rehydrate = () => Promise<void> | void;

const fns = new Set<Rehydrate>();

/** Registers a store's reload (cancel pending saves, re-read storage, notify listeners). */
export function registerRehydrate(fn: Rehydrate) {
  fns.add(fn);
}

export async function rehydrateAll() {
  await Promise.all([...fns].map((fn) => Promise.resolve().then(fn).catch((e) => console.warn('[huwa] rehydrate', e))));
}
