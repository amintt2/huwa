// AniList GraphQL transport (https://docs.anilist.co). Every request of the app goes through
// `gql`: identical anonymous requests in flight are shared, 4 run at a time, and after a 429 the
// whole app backs off (./request-gate.ts). It imports none of the catalog modules, so ./anilist.ts
// and ./anilist-api.ts both build on it without an import cycle.
import { isDemo } from '@/demo/flags';

import { cooldownFromResponse, createRequestGate, RateLimitedError } from './request-gate';

export const ENDPOINT = 'https://graphql.anilist.co';

export class AniListError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

/**
 * 4 at a time; after a 429 every request waits for `Retry-After` — or fails fast when the wait is
 * long, so screens show their cache instead of hanging.
 */
const gate = createRequestGate({ maxConcurrent: 4, maxWait: 8000 });
/** A short 429 cooldown is waited out once, then the request is sent again. */
const RETRY_UNDER_MS = 8000;

async function post<T>(query: string, variables: Record<string, unknown>, opts: { signal?: AbortSignal; token?: string }, retry = true): Promise<T> {
  const res = await gate.run(() =>
    fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
      signal: opts.signal,
    }),
  );
  const wait = cooldownFromResponse(res.status, res.headers);
  if (wait > 0) gate.backoff(wait);
  if (res.status === 429) {
    if (retry && wait <= RETRY_UNDER_MS && !opts.signal?.aborted) return post(query, variables, opts, false);
    throw new AniListError('Trop de requêtes AniList, réessaie dans un instant', 429);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.errors) {
    throw new AniListError(json?.errors?.[0]?.message ?? `AniList ${res.status}`, res.status);
  }
  return json.data as T;
}

export async function gql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  opts: { signal?: AbortSignal; token?: string } = {},
): Promise<T> {
  if (isDemo) throw new Error('AniList désactivé en mode démo');
  try {
    // Shared only when nobody can cancel it (an abort would fail the other callers too).
    if (opts.signal || opts.token) return await post<T>(query, variables, opts);
    return await gate.dedupe(`${query}\n${JSON.stringify(variables)}`, () => post<T>(query, variables, opts));
  } catch (e) {
    if (e instanceof RateLimitedError) throw new AniListError(e.message, 429);
    throw e;
  }
}
