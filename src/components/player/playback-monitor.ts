// What the player observes on the current source, for the source controller
// (addons/source-controller.ts `Playback`): stalls after the first frame, the buffer ahead and its
// trend, user seeks (not stalls), the engine's download rate and live peers for a torrent.
// A plain object fed by the player's events (usePlaybackMonitor in Player.tsx) and read by the
// controller on its own timer: nothing re-renders. Pure (clock injected): unit-tested.
import type { Playback } from '@/addons/source-controller';

/** A "loading" this soon after a user seek is the seek, not a stall. */
export const SEEK_GRACE_MS = 3000;
/** Buffer samples kept for the trend (ms of history). */
const TREND_WINDOW_MS = 10_000;
/** Stalls kept per source. */
const MAX_STALLS = 50;

type Sample = { at: number; ahead: number };

export class PlaybackMonitor {
  /** Source being observed (the player's URI). */
  uri: string | null = null;
  private loadAt = 0;
  private firstFrameAt: number | null = null;
  private stalls: { at: number; ms: number }[] = [];
  private stallStart: number | null = null;
  private seekAt = -Infinity;
  private samples: Sample[] = [];
  private position = 0;
  private duration = 0;
  private playing = false;
  private loading = false;
  private external = false;
  private throughput: number | undefined;
  private peers: number | undefined;

  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A new source was handed to the player (also after a switch: stats are per source). */
  reset(uri: string | null) {
    this.uri = uri;
    this.loadAt = this.now();
    this.firstFrameAt = null;
    this.stalls = [];
    this.stallStart = null;
    this.samples = [];
    this.duration = 0;
    this.position = 0;
    this.throughput = undefined;
    this.peers = undefined;
  }

  /**
   * A seamless swap: the new source is already playing (first frame shown). Its stalls start
   * from zero; the buffer history is reset too (another file).
   */
  adopt(uri: string) {
    this.reset(uri);
    this.firstFrameAt = this.now();
  }

  firstFrame() {
    if (this.firstFrameAt == null) this.firstFrameAt = this.now();
  }

  noteSeek() {
    this.seekAt = this.now();
    // A stall in progress ends with the seek (what follows is the seek's own loading).
    this.endStall();
  }

  setDuration(d: number) {
    if (d > 0 && Number.isFinite(d)) this.duration = d;
  }

  setPlaying(p: boolean) {
    this.playing = p;
  }

  setExternal(e: boolean) {
    this.external = e;
  }

  /** Player status: `loading` after the first frame (and not right after a seek) is a stall. */
  setLoading(loading: boolean) {
    this.loading = loading;
    const t = this.now();
    if (loading) {
      if (this.firstFrameAt == null || t - this.seekAt < SEEK_GRACE_MS || this.stallStart != null) return;
      this.stallStart = t;
      this.stalls.push({ at: t, ms: 0 });
      if (this.stalls.length > MAX_STALLS) this.stalls.shift();
    } else this.endStall();
  }

  private endStall() {
    if (this.stallStart == null) return;
    const last = this.stalls[this.stalls.length - 1];
    if (last && last.at === this.stallStart) last.ms = this.now() - this.stallStart;
    this.stallStart = null;
  }

  /** Time update: position and absolute buffered position (s). */
  progress(position: number, buffered: number) {
    this.position = position;
    const t = this.now();
    const ahead = buffered >= position ? buffered - position : -1;
    this.samples.push({ at: t, ahead });
    while (this.samples.length > 2 && t - this.samples[0].at > TREND_WINDOW_MS) this.samples.shift();
  }

  /** Torrent engine status of the current source (1 Hz). */
  torrent(downloadBps: number | undefined, peers: number | undefined) {
    this.throughput = downloadBps != null ? (downloadBps * 8) / 1e6 : undefined;
    this.peers = peers;
  }

  /** The source controller's view of this source right now. */
  snapshot(): Playback {
    const t = this.now();
    const stalls = this.stalls.map((s) => (this.stallStart != null && s.at === this.stallStart ? { at: s.at, ms: t - s.at } : s));
    const last = this.samples[this.samples.length - 1];
    const first = this.samples[0];
    let trend = NaN;
    if (first && last && last.at - first.at >= 3000 && first.ahead >= 0 && last.ahead >= 0) trend = (last.ahead - first.ahead) / ((last.at - first.at) / 1000);
    return {
      started: this.firstFrameAt != null,
      sinceLoadMs: t - this.loadAt,
      sincePlayMs: this.firstFrameAt == null ? 0 : t - this.firstFrameAt,
      playing: this.playing,
      busy: t - this.seekAt < SEEK_GRACE_MS || (this.loading && this.firstFrameAt == null),
      external: this.external,
      position: this.position,
      duration: this.duration,
      bufferAhead: last ? last.ahead : -1,
      bufferTrend: trend,
      stalls,
      stalledNowMs: this.stallStart != null ? t - this.stallStart : 0,
      throughputMbps: this.throughput,
      peers: this.peers,
    };
  }

  /** Stalls since `at` (switch stats: before / after a switch). */
  stallsSince(at: number): { count: number; ms: number } {
    const s = this.snapshot().stalls.filter((x) => x.at >= at);
    return { count: s.length, ms: Math.round(s.reduce((n, x) => n + x.ms, 0)) };
  }
}
