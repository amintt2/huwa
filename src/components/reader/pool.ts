// Bounded worker pool with all-or-nothing cancellation (pure, no I/O: tested in __tests__).
// The first failing task aborts its siblings, and the pool only settles once every worker has
// stopped: the caller can release ownership (its AbortController) without anything still writing.

/**
 * Runs `task(0..total-1)` with at most `concurrency` at once. Rejects with the first error after
 * all workers settled; `parent` aborting stops every worker too (rejects with an abort error).
 */
export async function runPool(total: number, concurrency: number, task: (i: number, signal: AbortSignal) => Promise<void>, parent?: AbortSignal): Promise<void> {
  const ctrl = new AbortController();
  const onParent = () => ctrl.abort();
  if (parent?.aborted) ctrl.abort();
  parent?.addEventListener('abort', onParent);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (next < total) {
      if (ctrl.signal.aborted) throw new Error('Annulé');
      const i = next++;
      await task(i, ctrl.signal);
    }
  };
  try {
    await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, total) }, () =>
        worker().catch((error) => {
          failure ??= { error };
          ctrl.abort();
          throw error;
        }),
      ),
    );
    if (failure) throw failure.error;
  } finally {
    parent?.removeEventListener('abort', onParent);
  }
}
