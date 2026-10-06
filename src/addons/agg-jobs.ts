// Addon answers for one episode and the aggregates built from them (no React; see `useAggregate`
// in ./registry.ts). Two levels:
// - `AddonAnswer`: one addon, one resource, one episode (its id formats). Shared by every screen
//   and every addon set: adding, removing, enabling or reordering an addon never asks the other
//   addons again, and an answer already in flight is joined, not restarted. Per answer:
//   1. an answer stored on disk (./stream-cache.ts) is shown at once; refreshed in the background
//      when older than a few minutes;
//   2. otherwise its id formats are asked two at a time (./fetch-policy.ts `firstUseful`), each
//      request retried once on a transient failure.
//   A negative answer (the addon failed, or had nothing playable — addons scraping in the
//   background often answer empty first) is only kept briefly: asked again after a short backoff
//   when a screen opens it, and automatically (twice at most) while a screen shows it.
// - `AggJob`: the answers of one addon set, in priority order, keyed by the set's hash (see
//   `aggregateKey`): a new set gets a new aggregate at once, made of the answers already known
//   plus the new addon's, so a cached "no source" verdict of the old set is never served.
// An answer keeps running while a screen uses it, plus a short grace period (screen handover);
// then no new request starts (requests in flight still land in the caches).
import { firstUseful, withRetry } from './fetch-policy';
import type { AddonRequest } from './id-candidates';
import type { InstalledAddon } from './addon-store';
import type { Resource } from './protocol';
import { dropAnswer, freshness, readAnswer, writeAnswer } from './stream-cache';

export type JobSpec = { a: InstalledAddon; reqs: AddonRequest[] };
export type Loader<T> = (a: InstalledAddon, req: AddonRequest) => Promise<T[]>;
export type JobOptions<T> = {
  useful?: (item: T) => boolean;
  /** Keep answers on disk (streams). */
  persist?: boolean;
  /** Marks an item served from the disk cache. */
  tag?: (item: T, cachedAt: number) => T;
  /** Two items of one addon are the same (merging answers of several id formats). */
  same?: (a: T, b: T) => boolean;
};

export type Agg<T> = {
  key: string;
  items: T[];
  done: number;
  failed: string[];
  /** Addons whose answer currently comes from the disk cache. */
  fromCache: number;
  /** Forced refreshes completed (see `refresh`). */
  refreshed: number;
};

/** Timings (mutable for tests). */
export const AGG_TIMING = {
  /** Unused aggregates and answers are forgotten after this long. */
  ttlMs: 20 * 60e3,
  /** A released answer keeps starting requests this long (screen handover). */
  releaseGraceMs: 4000,
  /** A failed addon (timeout, 5xx…) is asked again after this long, for this request only. */
  failureBackoffMs: 10_000,
  /** An answer with nothing playable is asked again after this long. */
  emptyRecheckMs: 30_000,
  /** Automatic re-asks of a negative answer while a screen shows it. */
  maxAutoRechecks: 2,
};

const PER_ADDON_CONCURRENCY = 2;
const reqKeyOf = (a: InstalledAddon, resource: Resource, req: AddonRequest) => `${resource}|${a.baseUrl}|${req.type}/${req.id}`;
const isBuiltin = (a: InstalledAddon) => a.baseUrl.startsWith('builtin:');

/** The request as sent: a lazy IMDb id once known (null: none for this episode, undefined: not yet). */
function settledReq(req: AddonRequest): AddonRequest | null | undefined {
  if (!req.lazy) return req;
  const id = req.lazy.peek();
  return id ? { type: req.type, id } : (id as null | undefined);
}

/** A lazy IMDb id that turned out to have nothing for this episode (not an addon failure). */
class NoCandidate extends Error {}

export class AddonAnswer<T> {
  items: T[] = [];
  done = false;
  failed = false;
  /** Shown from the disk cache (epoch ms of the stored answer). */
  cachedAt?: number;
  reqKey?: string;
  /** Negative answer (failed / nothing useful): asked again from this time (epoch ms). */
  retryAt?: number;
  /** Increments on every change (aggregate snapshots compare it). */
  version = 0;
  refs = 0;
  at = Date.now();
  private running: Promise<void> | null = null;
  private ctrl = new AbortController();
  private load!: Loader<T>;
  private listeners = new Set<() => void>();
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private recheckTimer: ReturnType<typeof setTimeout> | undefined;
  private rechecks = 0;

  readonly key: string;
  readonly resource: Resource;
  readonly spec: JobSpec;
  readonly opts: JobOptions<T>;

  constructor(key: string, resource: Resource, spec: JobSpec, opts: JobOptions<T>) {
    this.key = key;
    this.resource = resource;
    this.spec = spec;
    this.opts = opts;
  }

  get busy() {
    return this.running != null;
  }

  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  private emit() {
    this.version++;
    this.at = Date.now();
    this.listeners.forEach((l) => l());
  }

  retain(load: Loader<T>): () => void {
    this.load = load;
    this.refs++;
    this.at = Date.now();
    clearTimeout(this.stopTimer);
    if (this.ctrl.signal.aborted) this.ctrl = new AbortController();
    if (this.done && this.retryAt != null && Date.now() >= this.retryAt) {
      // Expired negative answer: not an answer any more, asked again (shown as searching).
      this.rechecks = 0;
      this.done = false;
      this.emit();
    }
    if (!this.done) void this.start(false);
    else this.scheduleRecheck();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs--;
      this.at = Date.now();
      if (this.refs > 0) return;
      clearTimeout(this.recheckTimer);
      clearTimeout(this.stopTimer);
      this.stopTimer = setTimeout(() => {
        if (this.refs === 0) this.ctrl.abort();
      }, AGG_TIMING.releaseGraceMs);
    };
  }

  /** Runs (or joins the run in flight). `network`: skip the disk cache. */
  private start(network: boolean): Promise<void> {
    if (this.running) return this.running;
    const run = (async () => {
      try {
        await this.run(network);
      } finally {
        this.running = null;
      }
      // Cancelled, then retained again while that run was finishing: the remaining id formats
      // were never asked. Run again with the new signal instead of staying "searching".
      if (this.refs > 0 && !this.done && !this.ctrl.signal.aborted) return this.start(false);
      this.scheduleRecheck();
    })();
    this.running = run;
    return run;
  }

  private async run(network: boolean) {
    const a = this.spec.a;
    if (!network && !this.done && this.opts.persist && !isBuiltin(a)) {
      for (const r of this.spec.reqs) {
        // A lazy IMDb id only when already known: the cache never waits for the season model.
        const req = settledReq(r);
        if (!req) continue;
        const key = reqKeyOf(a, this.resource, req);
        const hit = await readAnswer<T>(key);
        if (!hit || (this.opts.useful && !hit.items.some(this.opts.useful))) continue;
        const tag = this.opts.tag;
        Object.assign(this, { items: tag ? hit.items.map((x) => tag(x, hit.at)) : hit.items, done: true, failed: false, cachedAt: hit.at, reqKey: key, retryAt: undefined });
        this.emit();
        // Shown at once; refreshed when older than a few minutes (stale-while-revalidate).
        if (freshness(hit.at) === 'stale') await this.network();
        return;
      }
    }
    await this.network();
  }

  /** Asks the addon (all its id formats, two at a time), replacing what the answer shows. */
  private async network() {
    const signal = this.ctrl.signal;
    if (signal.aborted) return;
    const { spec } = this;
    const { useful, same } = this.opts;
    const merge = (items: T[]) => {
      const fresh = same ? items.filter((x) => !this.items.some((y) => same(x, y))) : items;
      if (!fresh.length) return;
      this.items = [...this.items, ...fresh];
      this.emit();
    };
    // Lazy IMDb ids (season model): resolved here, while the other formats are already asked.
    const sent = new Map<AddonRequest, AddonRequest>();
    let failures = 0;
    let skipped = 0;
    const ask = async (req: AddonRequest) => {
      let out = req;
      if (req.lazy) {
        const id = await req.lazy.resolve();
        if (!id) {
          skipped++;
          throw new NoCandidate('Pas d’identifiant IMDb pour cet épisode');
        }
        out = { type: req.type, id };
        sent.set(req, out);
      }
      try {
        return await withRetry(() => this.load(spec.a, out), { signal });
      } catch (e) {
        failures++;
        throw e;
      }
    };
    try {
      const { items, index } = await firstUseful(spec.reqs, ask, useful, { concurrency: PER_ADDON_CONCURRENCY, signal, onExtra: merge });
      const isUseful = !useful || items.some(useful);
      // Background refresh that found nothing better: keep the cached answer.
      if (this.cachedAt != null && !isUseful) return;
      // Stopped before every id format was tried: not an answer yet (runs again when retained).
      if (!isUseful && signal.aborted) return;
      Object.assign(this, {
        items,
        done: true,
        failed: false,
        cachedAt: undefined,
        // Nothing playable yet (addons scraping in the background answer empty first): asked again soon.
        retryAt: isUseful ? undefined : Date.now() + AGG_TIMING.emptyRecheckMs,
      });
      if (isUseful) this.rechecks = 0;
      const answered = index >= 0 ? (sent.get(spec.reqs[index]) ?? spec.reqs[index]) : undefined;
      if (isUseful && this.opts.persist && answered && !answered.lazy && !isBuiltin(spec.a)) {
        this.reqKey = reqKeyOf(spec.a, this.resource, answered);
        void writeAnswer(this.reqKey, items);
      }
      this.emit();
    } catch {
      if (this.cachedAt != null) return;
      // Cancelled before any request could start: not a failure, it may run again.
      if (signal.aborted && !this.items.length) return;
      // Its only id format was an IMDb id this episode does not have: nothing, not a failure.
      const none = failures === 0 && skipped > 0;
      // A failure only holds for this addon request, and only for a short backoff.
      Object.assign(this, { done: true, failed: !none, retryAt: none ? undefined : Date.now() + AGG_TIMING.failureBackoffMs });
      this.emit();
    }
  }

  /** While a screen shows a negative answer, it is asked again (a few times) after its backoff. */
  private scheduleRecheck() {
    clearTimeout(this.recheckTimer);
    if (this.refs === 0 || !this.done || this.retryAt == null || this.rechecks >= AGG_TIMING.maxAutoRechecks) return;
    this.recheckTimer = setTimeout(() => {
      if (this.refs === 0 || this.running || this.retryAt == null) return;
      this.rechecks++;
      // Quietly: the current verdict stays on screen until a better answer arrives.
      void this.start(true);
    }, Math.max(0, this.retryAt - Date.now()));
  }

  /**
   * Fetches again an answer that came from the disk cache (a cached link failed: debrid / proxy
   * URLs expire), or any answer with `all` ("Réessayer"). A run in flight is awaited instead of
   * being duplicated (its answer is the fresh one).
   */
  async refresh(all: boolean) {
    if (this.running) {
      await this.running;
      if (this.cachedAt == null) return;
    }
    if (!all && this.cachedAt == null) return;
    if (this.ctrl.signal.aborted) this.ctrl = new AbortController();
    if (this.reqKey) void dropAnswer(this.reqKey);
    this.rechecks = 0;
    // Shown again as "searching" only when it had nothing to show.
    if (all && !this.items.length) {
      Object.assign(this, { done: false, failed: false });
      this.emit();
    }
    await this.start(true);
  }
}

/** The answers of one addon set, in priority order. */
export class AggJob<T> {
  refs = 0;
  at = Date.now();
  private refreshed = 0;
  private sig = '';
  private snap: Agg<T>;
  private listeners = new Set<() => void>();

  readonly key: string;
  readonly answers: AddonAnswer<T>[];

  constructor(key: string, answers: AddonAnswer<T>[]) {
    this.key = key;
    this.answers = answers;
    this.snap = { key, items: [], done: 0, failed: [], fromCache: 0, refreshed: 0 };
  }

  subscribe = (l: () => void) => {
    const offs = this.answers.map((a) => a.subscribe(l));
    this.listeners.add(l);
    return () => {
      offs.forEach((off) => off());
      this.listeners.delete(l);
    };
  };

  /** Stable while nothing changed (`useSyncExternalStore`). */
  getSnapshot = (): Agg<T> => {
    const sig = `${this.refreshed}|${this.answers.map((a) => a.version).join(',')}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.snap = {
        key: this.key,
        items: this.answers.flatMap((a) => a.items),
        done: this.answers.filter((a) => a.done).length,
        failed: this.answers.filter((a) => a.failed).map((a) => a.spec.a.manifest.name),
        fromCache: this.answers.filter((a) => a.cachedAt != null).length,
        refreshed: this.refreshed,
      };
    }
    return this.snap;
  };

  retain(load: Loader<T>) {
    this.refs++;
    this.at = Date.now();
    const releases = this.answers.map((a) => a.retain(load));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs--;
      this.at = Date.now();
      releases.forEach((r) => r());
    };
  }

  /** See `AddonAnswer.refresh`; `refreshed` increments when done. */
  async refresh(all = false) {
    await Promise.all(this.answers.map((a) => a.refresh(all)));
    this.refreshed++;
    this.listeners.forEach((l) => l());
  }
}

const answers = new Map<string, AddonAnswer<unknown>>();
const aggs = new Map<string, AggJob<unknown>>();

/** What every aggregate of one episode shares: resource (+ variant), series, episode. */
export const aggregateBase = (resource: Resource, variant: string, seriesId: string, episode: number) =>
  `${resource}${variant ? `#${variant}` : ''}|${seriesId}|${episode}`;

const specSig = (s: JobSpec) => `${s.a.baseUrl}>${s.reqs.map((r) => `${r.type}/${r.id}`).join(',')}`;

/** Key of one aggregate: the episode, the installed set's hash and the addons asked (in order). */
export const aggregateKey = (base: string, setHash: string, specs: JobSpec[]) => `${base}|set:${setHash}|${specs.map(specSig).join('|')}`;

function prune(now = Date.now()) {
  for (const [k, j] of aggs) if (j.refs === 0 && now - j.at > AGG_TIMING.ttlMs) aggs.delete(k);
  const used = new Set<AddonAnswer<unknown>>();
  for (const j of aggs.values()) j.answers.forEach((a) => used.add(a));
  for (const [k, a] of answers) if (!used.has(a) && a.refs === 0 && !a.busy && now - a.at > AGG_TIMING.ttlMs) answers.delete(k);
}

/** The aggregate of `specs` for one episode: answers already known (or in flight) are reused. */
export function obtainAggregate<T>(base: string, setHash: string, resource: Resource, specs: JobSpec[], opts: JobOptions<T>): AggJob<T> {
  prune();
  const key = aggregateKey(base, setHash, specs);
  let job = aggs.get(key) as AggJob<T> | undefined;
  if (!job) {
    const list = specs.map((s) => {
      const k = `${base}|${specSig(s)}`;
      let a = answers.get(k) as AddonAnswer<T> | undefined;
      if (!a) {
        a = new AddonAnswer<T>(k, resource, s, opts);
        answers.set(k, a as AddonAnswer<unknown>);
      }
      return a;
    });
    job = new AggJob<T>(key, list);
    aggs.set(key, job as AggJob<unknown>);
  }
  return job;
}

/** A screen (watch screen, presearch, download) is searching this episode right now. */
export function episodeInUse(base: string): boolean {
  for (const [k, j] of aggs) if (j.refs > 0 && k.startsWith(`${base}|set:`)) return true;
  return false;
}

/** Test helper. */
export function resetAggregates() {
  aggs.clear();
  answers.clear();
}
