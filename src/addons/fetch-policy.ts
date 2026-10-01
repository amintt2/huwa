// How addon requests are retried and how an addon's id formats are tried (pure, unit-tested).

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done);
  });

/**
 * Worth a second try: timeouts, network errors, 5xx, 408 and 429. A 4xx means the addon does not
 * know this id: asking again changes nothing.
 */
export function isTransient(e: unknown): boolean {
  if (!(e instanceof Error)) return true;
  if (e.name === 'AbortError' || /abort|timeout|délai/i.test(e.message)) return true;
  const http = /HTTP (\d{3})/.exec(e.message);
  if (!http) return true; // TypeError: Network request failed…
  const code = Number(http[1]);
  return code >= 500 || code === 408 || code === 429;
}

export type RetryOptions = { retries?: number; backoffMs?: number; signal?: AbortSignal; shouldRetry?: (e: unknown) => boolean };

/** Runs `fn`, retrying a transient failure `retries` times (default once) after a backoff. */
export async function withRetry<T>(fn: () => Promise<T>, { retries = 1, backoffMs = 800, signal, shouldRetry = isTransient }: RetryOptions = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || signal?.aborted || !shouldRetry(e)) throw e;
      await sleep(backoffMs * 2 ** attempt, signal);
      if (signal?.aborted) throw e;
    }
  }
}

export type FirstUsefulOptions<T> = {
  /** Requests in flight at once (default 2). */
  concurrency?: number;
  signal?: AbortSignal;
  /** A useful answer that came in after the first one (from a request already in flight). */
  onExtra?: (items: T[], index: number) => void;
};

/**
 * Tries `reqs` in order, `concurrency` at a time, and resolves with the first answer containing
 * a useful item (no new request starts after that; the ones in flight report through `onExtra`).
 * Nothing useful anywhere: the highest-priority answer (e.g. status rows "no result"), or the
 * error of the first request when every request failed.
 */
export function firstUseful<R, T>(
  reqs: R[],
  load: (req: R) => Promise<T[]>,
  useful: ((item: T) => boolean) | undefined,
  { concurrency = 2, signal, onExtra }: FirstUsefulOptions<T> = {},
): Promise<{ items: T[]; index: number }> {
  return new Promise((resolve, reject) => {
    if (!reqs.length) return resolve({ items: [], index: -1 });
    const answers: ({ items: T[] } | { error: unknown } | undefined)[] = reqs.map(() => undefined);
    let next = 0;
    let active = 0;
    let settled = false;
    const isUseful = (items: T[]) => !useful || items.some(useful);
    const finish = () => {
      if (settled) return;
      settled = true;
      const firstAnswer = answers.findIndex((a) => a && 'items' in a);
      if (firstAnswer >= 0) resolve({ items: (answers[firstAnswer] as { items: T[] }).items, index: firstAnswer });
      else reject((answers.find((a) => a && 'error' in a) as { error: unknown } | undefined)?.error ?? new Error('Aucune réponse'));
    };
    const pump = () => {
      while (!settled && !signal?.aborted && active < Math.max(1, concurrency) && next < reqs.length) {
        const i = next++;
        active++;
        load(reqs[i])
          .then((items) => {
            answers[i] = { items };
            if (!isUseful(items)) return;
            if (!settled) {
              settled = true;
              resolve({ items, index: i });
            } else onExtra?.(items, i);
          })
          .catch((error: unknown) => {
            answers[i] = { error };
          })
          .finally(() => {
            active--;
            pump();
            if (!settled && active === 0 && (next >= reqs.length || signal?.aborted)) finish();
          });
      }
    };
    pump();
    if (active === 0) finish();
  });
}
