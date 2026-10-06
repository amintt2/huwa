// Timings of an episode start: tap → screen → first sources → source chosen → URL ready → first
// frame, then re-buffering over the first 5 minutes. Each start becomes one anonymous event in the
// on-device statistics (src/stats/store.ts, "Statistiques de lecture"); in development builds a
// line is also printed in the Metro console once the first frame shows, e.g.
//   [huwa:start] al154587:3 · écran 180 ms · sources 420 ms (cache) · choix 900 ms · URL 900 ms · image 1650 ms
// Cheap: a Map entry per episode opened and a few timestamps. The episode id is only the key of
// the trace in memory: it is never written to the statistics.
import { engineStartOf, type EngineKind, type EngineTimeline, type FailReason, type NetKind, type PlaybackEvent, type PlayPath, type StartKind } from '@/stats/model';
import { recordPlayback } from '@/stats/store';

declare const __DEV__: boolean | undefined;
const dev = typeof __DEV__ !== 'undefined' && !!__DEV__;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** `file-loaded`: the player opened the file (mpv `file-loaded`, expo-video `sourceLoad`). */
export type StartMark = 'screen' | 'sources' | 'decision' | 'url' | 'file-loaded' | 'first-frame';
/** What the watch screen / player know about the start (see `traceInfo`). */
export type TraceInfo = {
  kind: StartKind;
  path: PlayPath;
  engine: EngineKind;
  warm: boolean;
  fallbackToMpv: boolean;
  network: NetKind;
  /** Built-in torrent engine: its start timeline (latest status) and the bytes served at the first frame. */
  engineTimeline: EngineTimeline;
  engineBytesAtFrame: number;
};

type Trace = {
  t0: number;
  at: number;
  marks: Partial<Record<StartMark, number>>;
  notes: string[];
  printed: boolean;
  tapped: boolean;
  info: Partial<TraceInfo>;
  stalls: number;
  stalledMs: number;
  stallStart?: number;
  failed?: FailReason;
  done: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

/** Re-buffering is watched over the first 5 minutes after the first frame. */
const STALL_WINDOW_MS = 5 * 60_000;
/** Leaving before the first frame after this long counts as a failed start (gave up waiting). */
const GAVE_UP_MS = 20_000;

const traces = new Map<string, Trace>();
let active: string | undefined;
/** Last finished start (series + number), to tell "Épisode suivant" from a fresh start. */
let lastDone: { id: string; at: number } | undefined;
const LABEL: Record<StartMark, string> = { screen: 'écran', sources: 'sources', decision: 'choix', url: 'URL', 'file-loaded': 'fichier ouvert', 'first-frame': 'image' };

const fresh = (tapped: boolean): Trace => ({
  t0: now(), at: Date.now(), marks: {}, notes: [], printed: false, tapped, info: {}, stalls: 0, stalledMs: 0, done: false,
});

/** "al154587:3" follows "al154587:2". */
function followsLast(id: string): boolean {
  if (!lastDone || Date.now() - lastDone.at > 15 * 60_000) return false;
  const a = /^(.*):(\d+)$/.exec(id);
  const b = /^(.*):(\d+)$/.exec(lastDone.id);
  return !!a && !!b && a[1] === b[1] && Number(a[2]) === Number(b[2]) + 1;
}

/** The user asked to play `episodeId` (button press). */
export function traceTap(episodeId: string) {
  const prev = traces.get(episodeId);
  if (prev) finish(episodeId, prev);
  // Taps that never led to a watch screen (no mark): forget the oldest ones.
  if (traces.size > 50) {
    for (const [k, t] of traces) if (k !== active && !Object.keys(t.marks).length) traces.delete(k);
  }
  traces.set(episodeId, fresh(true));
}

/** First occurrence of a step for this episode (later ones are ignored). */
export function traceMark(episodeId: string, mark: StartMark, note?: string) {
  let t = traces.get(episodeId);
  // Opened without a tracked tap (deep link, "Épisode suivant"): time from the screen.
  const stale = !!t && mark === 'screen' && (t.marks.screen != null || now() - t.t0 > 30_000);
  if (!t || t.done || stale) {
    if (t && !t.done) finish(episodeId, t);
    t = fresh(false);
    if (followsLast(episodeId)) t.info.kind = 'next';
    traces.set(episodeId, t);
  }
  if (mark === 'screen') active = episodeId;
  if (t.marks[mark] != null) return;
  t.marks[mark] = now() - t.t0;
  if (note) t.notes.push(`${LABEL[mark]}: ${note}`);
  if (mark === 'first-frame') {
    lastDone = { id: episodeId, at: Date.now() };
    const trace = t;
    trace.timer = setTimeout(() => finish(episodeId, trace), STALL_WINDOW_MS);
    if (dev && !t.printed) {
      t.printed = true;
      const parts = (Object.keys(LABEL) as StartMark[])
        .filter((k) => t!.marks[k] != null)
        .map((k) => `${LABEL[k]} ${Math.round(t!.marks[k]!)} ms`);
      console.log(`[huwa:start] ${episodeId} · ${parts.join(' · ')}${t.notes.length ? ` (${t.notes.join(', ')})` : ''}`);
    }
  }
}

/** Marks the episode on screen (hosted web player, which has no episode key). */
export function traceActive(mark: StartMark) {
  if (active) traceMark(active, mark);
}

/** Facts about the start (path, engine, warm handover…); the first value of `kind` wins. */
export function traceInfo(episodeId: string, info: Partial<TraceInfo>) {
  const t = traces.get(episodeId);
  if (!t || t.done) return;
  const { kind, ...rest } = info;
  if (kind && !t.info.kind) t.info.kind = kind;
  Object.assign(t.info, rest);
}

/** Re-buffering after the first frame (`on` = waiting for data, `off` = playing again). */
export function traceStall(episodeId: string, on: boolean) {
  const t = traces.get(episodeId);
  if (!t || t.done || t.marks['first-frame'] == null) return;
  if (on && t.stallStart == null) {
    t.stallStart = now();
    t.stalls++;
  } else if (!on && t.stallStart != null) {
    t.stalledMs += now() - t.stallStart;
    t.stallStart = undefined;
  }
}

/** Nothing could start (no source, every source failed…). Ignored once something played. */
export function traceFail(episodeId: string, reason: FailReason) {
  const t = traces.get(episodeId);
  if (!t || t.done || t.marks['first-frame'] != null) return;
  t.failed = reason;
}

/** The watch screen closed: the start is recorded (if there is something to say about it). */
export function traceEnd(episodeId: string) {
  const t = traces.get(episodeId);
  if (t) finish(episodeId, t);
  if (active === episodeId) active = undefined;
}

/** Builds the anonymous event of a trace (null when nothing meaningful happened). */
export function eventOf(t: Pick<Trace, 'at' | 'marks' | 'info' | 'stalls' | 'stalledMs' | 'failed' | 'stallStart'>, elapsed: number, nowMs = now()): PlaybackEvent | null {
  const played = t.marks['first-frame'] != null;
  let failed = played ? undefined : t.failed;
  // Left before anything showed: a failure only after a long wait (else the user changed their mind).
  if (!played && !failed) {
    if (t.marks.screen == null || elapsed < GAVE_UP_MS || (t.marks.url == null && t.marks.decision == null && t.marks.sources == null && elapsed < 60_000)) return null;
    failed = 'timeout';
  }
  const r = (v?: number) => (v == null ? undefined : Math.round(v));
  const openStall = t.stallStart != null ? nowMs - t.stallStart : 0;
  return {
    at: t.at,
    kind: t.info.kind ?? 'start',
    path: t.info.path,
    engine: t.info.path === 'web-player' ? undefined : t.info.engine,
    warm: !!t.info.warm,
    tSources: r(t.marks.sources),
    tDecision: r(t.marks.decision),
    tUrl: r(t.marks.url),
    tFirstFrame: r(t.marks['first-frame']),
    stalls: t.stalls,
    stalledMs: Math.round(t.stalledMs + openStall),
    failed,
    fallbackToMpv: !!t.info.fallbackToMpv,
    network: t.info.network,
    tFileLoaded: r(t.marks['file-loaded']),
    engineStart: t.info.engineTimeline ? engineStartOf(t.info.engineTimeline, t.at, t.info.engineBytesAtFrame) : undefined,
  };
}

function finish(id: string, t: Trace) {
  if (t.done) return;
  t.done = true;
  clearTimeout(t.timer);
  if (traces.get(id) === t) traces.delete(id);
  const e = eventOf(t, now() - t.t0);
  if (!e) return;
  if (e.tFirstFrame != null) lastDone = { id, at: Date.now() };
  try {
    recordPlayback(e);
  } catch {
    // statistics must never break playback
  }
}
