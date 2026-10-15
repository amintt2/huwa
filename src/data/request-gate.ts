// Politeness toward a rate-limited API (AniList: ~90 requests/min, 30 in degraded mode, 429s seen
// in the field). Pure, unit tested in src/data/__tests__/request-gate.test.ts.
//
// · At most `maxConcurrent` requests at once, the others wait in order.
// · Identical requests in flight are shared (`dedupe`).
// · After a 429 (or when the API says the budget is spent) every request waits for the cooldown;
//   a cooldown longer than `maxWait` fails fast instead, so screens fall back to their cache.

export class RateLimitedError extends Error {
  retryInMs: number;
  constructor(retryInMs: number) {
    super(`Trop de requêtes, réessaie dans ${Math.ceil(retryInMs / 1000)} s`);
    this.retryInMs = retryInMs;
  }
}

export type GateConfig = {
  maxConcurrent?: number;
  /** Longest cooldown a request agrees to wait for (ms). */
  maxWait?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export function createRequestGate(config: GateConfig = {}) {
  const maxConcurrent = config.maxConcurrent ?? 4;
  const maxWait = config.maxWait ?? 10_000;
  const now = config.now ?? Date.now;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let cooldownUntil = 0;
  let active = 0;
  const waiting: (() => void)[] = [];
  const shared = new Map<string, Promise<unknown>>();

  const cooldown = () => Math.max(0, cooldownUntil - now());

  /** No request before `ms` from now (keeps the longest of the cooldowns asked). */
  function backoff(ms: number) {
    cooldownUntil = Math.max(cooldownUntil, now() + Math.max(0, ms));
  }

  async function acquire() {
    if (active >= maxConcurrent) await new Promise<void>((r) => waiting.push(r));
    active++;
  }
  function release() {
    active--;
    waiting.shift()?.();
  }

  /** Runs `task` once a slot is free and the cooldown is over (or rejects when it is too long). */
  async function run<T>(task: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      const wait = cooldown();
      if (wait > maxWait) throw new RateLimitedError(wait);
      if (wait > 0) await sleep(wait);
      return await task();
    } finally {
      release();
    }
  }

  /** Same `key` in flight: the running promise is returned instead of a new request. */
  function dedupe<T>(key: string, task: () => Promise<T>): Promise<T> {
    const running = shared.get(key);
    if (running) return running as Promise<T>;
    const p = task().finally(() => shared.delete(key));
    shared.set(key, p);
    return p;
  }

  return { run, dedupe, backoff, cooldown, inFlight: () => active, queued: () => waiting.length };
}

/**
 * Cooldown asked by a response (ms), or 0: a 429's `Retry-After` (seconds, or an HTTP date), and
 * `X-RateLimit-Remaining: 0` with its `X-RateLimit-Reset` (unix seconds).
 */
export function cooldownFromResponse(status: number, headers: { get(name: string): string | null }, now = Date.now()): number {
  if (status === 429) {
    const ra = headers.get('Retry-After');
    if (ra) {
      const secs = Number(ra);
      if (Number.isFinite(secs)) return Math.max(1000, secs * 1000);
      const date = Date.parse(ra);
      if (Number.isFinite(date)) return Math.max(1000, date - now);
    }
    const reset = Number(headers.get('X-RateLimit-Reset'));
    return Number.isFinite(reset) && reset > 0 ? Math.max(1000, reset * 1000 - now) : 60_000;
  }
  const remaining = headers.get('X-RateLimit-Remaining');
  if (remaining !== null && Number(remaining) <= 0) {
    const reset = Number(headers.get('X-RateLimit-Reset'));
    return Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - now) : 30_000;
  }
  return 0;
}
