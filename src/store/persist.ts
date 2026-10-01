// Debounced persistence shared by the tiny stores (progress, lists…). A write is delayed so a
// burst of changes costs one AsyncStorage call, but nothing may be lost when iOS suspends or
// kills the app: every pending write is flushed when the app leaves the foreground
// (`flushPendingWrites`, wired to AppState in the root layout) and before the player's
// save-on-leave completes. Pure (no React Native import) so it can be unit-tested.

export type DebouncedWriter = {
  /** (Re)starts the delay; the write reads the store's state when it runs. */
  schedule(): void;
  /** Writes now if a write is pending; resolves once every write started so far is done. */
  flush(): Promise<void>;
  /** Drops the pending write (e.g. the state was just re-read from storage). */
  cancel(): void;
  pending(): boolean;
};

const writers = new Set<DebouncedWriter>();

export function debouncedWriter(write: () => Promise<unknown>, delay: number): DebouncedWriter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Writes are chained: a flush never races an older write still in flight.
  let chain: Promise<void> = Promise.resolve();
  const run = () => {
    timer = undefined;
    chain = chain.then(write).then(
      () => undefined,
      () => undefined,
    );
    return chain;
  };
  const w: DebouncedWriter = {
    schedule() {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(run, delay);
    },
    flush() {
      if (timer === undefined) return chain;
      clearTimeout(timer);
      return run();
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    pending: () => timer !== undefined,
  };
  writers.add(w);
  return w;
}

/** Writes every pending change now (app going to background, player closing). */
export function flushPendingWrites(): Promise<void> {
  return Promise.all([...writers].map((w) => w.flush())).then(() => undefined);
}

/** Drops every pending change (account deletion: nothing may be written back). */
export function cancelPendingWrites() {
  writers.forEach((w) => w.cancel());
}

/**
 * Settings-like stores load their saved value asynchronously at startup. A change made before
 * that (a deep link, a very early tap) used to be overwritten by the late load, and its own
 * write wiped the saved fields with defaults. The gate keeps such early patches, re-applies them
 * on top of the saved value, and says when writing is safe.
 */
export function hydrationGate<T extends object>() {
  let ready = false;
  let early: Partial<T> | null = null;
  return {
    isReady: () => ready,
    /** Records a patch; true when the store may persist now (already hydrated). */
    patch(p: Partial<T>): boolean {
      if (ready) return true;
      early = { ...early, ...p };
      return false;
    },
    /** Saved value + early patches. `dirty`: something changed before hydration, persist it. */
    settle(saved: T): { value: T; dirty: boolean } {
      ready = true;
      const value = early ? { ...saved, ...early } : saved;
      const dirty = !!early;
      early = null;
      return { value, dirty };
    },
  };
}

/** AppState values after which iOS may suspend (then kill) the app without warning. */
export const leavesForeground = (appState: string) => appState === 'background' || appState === 'inactive';
