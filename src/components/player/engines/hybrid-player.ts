// A player object with the subset of expo-video's `VideoPlayer` API that Player.tsx uses
// (properties, play/pause/replaceAsync, the same events and payloads), backed by either
// expo-video (AVPlayer / ExoPlayer) or libmpv (modules/huwa-mpv). The engine is chosen per source
// (policy.ts) and switches to mpv when the native engine fails on a source.
import type { EventEmitter } from 'expo-modules-core/types';
import { createVideoPlayer, type AudioTrack, type SubtitleTrack, type VideoPlayer, type VideoPlayerEvents, type VideoPlayerStatus, type VideoSource, type VideoTrack } from 'expo-video';
import { Platform } from 'react-native';

import { getSettings } from '@/settings/settings';

import HuwaMpv, { getMpvNativeView, type MpvLoadedEvent, type MpvProgressEvent, type MpvStateEvent, type MpvTrack, type MpvViewHandle } from '../../../../modules/huwa-mpv';

import './local-probe';
import { decideEngine, type DeviceCaps, type Engine } from './policy';
import { getEnginePref, setActiveEngine } from './prefs';
import { cachedProbe, probeSource } from './probe';

type Listener = (...args: any[]) => void;
type Subscription = { remove(): void };
type Src = { uri: string; headers?: Record<string, string>; metadata?: unknown };

let caps: DeviceCaps | null = null;
export function deviceCaps(): DeviceCaps {
  if (caps) return caps;
  let mpvAvailable = false;
  let hw: DeviceCaps['hw'] = {};
  try {
    mpvAvailable = !!HuwaMpv?.isAvailable() && !!getMpvNativeView();
    hw = HuwaMpv?.hardwareDecoders() ?? {};
  } catch {
    mpvAvailable = false;
  }
  caps = { platform: Platform.OS, mpvAvailable, hw };
  return caps;
}

// ISO 639-2 (Matroska) → 639-1, so the "preferred subtitle language" logic of the Player matches.
const LANG: Record<string, string> = {
  fre: 'fr', fra: 'fr', eng: 'en', jpn: 'ja', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', rus: 'ru',
  ara: 'ar', chi: 'zh', zho: 'zh', kor: 'ko', pol: 'pl', tur: 'tr', dut: 'nl', nld: 'nl', swe: 'sv', vie: 'vi',
  tha: 'th', ind: 'id', hin: 'hi', heb: 'he', gre: 'el', ell: 'el', cze: 'cs', ces: 'cs', hun: 'hu', rum: 'ro',
  ron: 'ro', ukr: 'uk', may: 'ms', msa: 'ms', fil: 'tl', tgl: 'tl', dan: 'da', fin: 'fi', nor: 'no', nob: 'nb',
};
export const normLang = (l: string) => {
  const s = (l || '').toLowerCase();
  return LANG[s] ?? s;
};

/** `forced` is not part of expo-video's track type: read by the subtitle controller (EmbeddedInput). */
function toTrack(t: MpvTrack): AudioTrack & SubtitleTrack & { forced?: boolean } {
  const language = normLang(t.lang) || 'und';
  const label = t.title || (t.lang ? t.lang.toUpperCase() : `Piste ${t.id}`);
  return { id: `mpv:${t.id}`, language, label, name: t.title || undefined, isDefault: t.default, forced: !!t.forced };
}
function parseTracks(json: string): MpvTrack[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
const mpvId = (t: { id?: string } | null | undefined) => (t?.id?.startsWith('mpv:') ? Number(t.id.slice(4)) : -1);
/** Title of the external subtitle file handed to libass (hidden from the track lists). */
const EXT_SUB_TITLE = 'huwa-external';
/** View calls added after the first mpv builds: absent on an older binary. */
const quiet = (p: Promise<void> | undefined) => {
  p?.catch(() => {});
};

const NATIVE_LOAD_TIMEOUT = 15_000;
/** A player is released only after its VideoView had time to unmount. */
const RELEASE_DELAY_MS = 1500;

function releaseLater(p: VideoPlayer) {
  setTimeout(() => {
    try {
      p.release();
    } catch {
      // already released
    }
  }, RELEASE_DELAY_MS);
}

const FORWARDED = [
  'statusChange', 'playingChange', 'playbackRateChange', 'volumeChange', 'mutedChange', 'playToEnd', 'timeUpdate',
  'sourceChange', 'availableSubtitleTracksChange', 'subtitleTrackChange', 'availableAudioTracksChange',
  'audioTrackChange', 'videoTrackChange', 'sourceLoad', 'isExternalPlaybackActiveChange',
] as const;

type MpvState = {
  status: VideoPlayerStatus;
  time: number;
  duration: number;
  buffered: number;
  paused: boolean;
  buffering: boolean;
  audio: AudioTrack[];
  subs: SubtitleTrack[];
  audioTrack: AudioTrack | null;
  subtitleTrack: SubtitleTrack | null;
  videoTrack: VideoTrack | null;
};
/**
 * What the seamless switch (seamless-upgrade.ts) needs from a hidden warm player: expo-video's
 * VideoPlayer has it, and so does the hidden mpv view (`MpvStage.facade`).
 */
export type StagedPlayer = {
  readonly status: VideoPlayerStatus;
  /** Setting it parks the warm player there (mpv: a precise seek). */
  currentTime: number;
  /** -1 when the engine cannot tell (a paused mpv reports nothing). */
  readonly bufferedPosition: number;
  readonly duration: number;
};

/** A second, hidden libmpv view warming the next source while mpv plays (seamless switch). */
type MpvStage = {
  slot: number;
  src: Src;
  view: MpvViewHandle | null;
  viewReady: boolean;
  started: boolean;
  loaded: boolean;
  firstFrame: boolean;
  seeking: boolean;
  error: boolean;
  /** Opened there (s): the playhead of the visible player plus a lead. */
  start: number;
  time: number;
  duration: number;
  buffered: number;
  tracks: MpvTrack[];
  videoCodec: string;
  hwdec: string;
  size: { width: number; height: number } | null;
  facade: StagedPlayer;
};

/** Event handlers + ref of one mpv surface (EngineView renders one per slot). */
export type MpvSlotProps = {
  ref: (h: MpvViewHandle | null) => void;
  onReady: () => void;
  onLoaded: (e: { nativeEvent: MpvLoadedEvent }) => void;
  onProgress: (e: { nativeEvent: MpvProgressEvent }) => void;
  onStateChange: (e: { nativeEvent: MpvStateEvent }) => void;
  onTracks: (e: { nativeEvent: { tracks: string } }) => void;
  onEnd: () => void;
  onMpvError: (e: { nativeEvent: { message: string } }) => void;
};

/** Two releases of one episode whose lengths differ more than this are not the same cut. */
const TIMELINE_TOLERANCE_S = 3;

const freshMpv = (): MpvState => ({
  status: 'loading', time: 0, duration: 0, buffered: 0, paused: true, buffering: false,
  audio: [], subs: [], audioTrack: null, subtitleTrack: null, videoTrack: null,
});

export class HybridPlayer implements EventEmitter<VideoPlayerEvents> {
  /** Type-only marker read by `useEvent` / `useEventListener` to infer the events map. */
  _TEventsMap_DONT_USE_IT?: VideoPlayerEvents;
  /** Native player on screen. Replaced by `commitStage` (seamless source upgrade). */
  native: VideoPlayer;
  engine: Engine = 'native';
  /** Why mpv is used ("conteneur MKV", "échec du lecteur natif"…), empty for the default engine. */
  reason = '';

  private listeners = new Map<string, Set<Listener>>();
  private engineListeners = new Set<() => void>();
  private nativeSubs: Subscription[] = [];
  private view: MpvViewHandle | null = null;
  private viewWaiters: ((v: MpvViewHandle | null) => void)[] = [];
  private src: Src | null = null;
  private token = 0;
  private fallbackTried: string | null = null;
  private pending: { resolve: () => void } | null = null;
  private m: MpvState = freshMpv();
  private rate = 1;
  private vol = 1;
  private detail = '';
  /** Position mpv was asked to open the current file at (0 = start), until the next seek. */
  private mpvStart = 0;
  /** mpv's first frame of the current file (start timings; expo-video has `onFirstFrameRender`). */
  private firstFrameListeners = new Set<() => void>();
  /** The first native player belongs to `useVideoPlayer` (released by the hook); later ones to us. */
  private ownsNative = false;
  /** `sub-…` options for the subtitles mpv draws (user's look, sync offset). */
  private subOpts: Record<string, string> = {};
  /** Styled ASS file drawn by libass instead of the overlay, and its mpv track id once added. */
  private extSub: { path: string; lang: string } | null = null;
  private extSubId = -1;
  private mpvLoaded = false;
  /** Hidden native player warming a better source (seamless upgrade). */
  private staged: { player: VideoPlayer; src: Src } | null = null;
  /** Native players to render, bottom to top (the staged one sits under the visible one). */
  private views: VideoPlayer[];
  /** Hidden mpv view warming a better source (seamless switch while mpv plays). */
  private mpvStage: MpvStage | null = null;
  /** mpv surfaces to render (slot ids); `mainSlot` is the visible one, on top. */
  private slots: number[] = [1];
  private mainSlot = 1;
  private nextSlot = 2;
  private slotProps = new Map<number, MpvSlotProps>();

  constructor(native: VideoPlayer) {
    this.native = native;
    this.views = [native];
    this.forward(native);
  }

  private forward(native: VideoPlayer) {
    this.nativeSubs.forEach((s) => s.remove());
    this.nativeSubs = FORWARDED.map((name) =>
      native.addListener(name, ((...args: unknown[]) => this.onNativeEvent(name, args)) as never),
    );
  }

  // ---------- EventEmitter ----------
  addListener<E extends keyof VideoPlayerEvents>(eventName: E, listener: VideoPlayerEvents[E]): Subscription {
    let set = this.listeners.get(eventName);
    if (!set) this.listeners.set(eventName, (set = new Set()));
    set.add(listener as Listener);
    return { remove: () => this.removeListener(eventName, listener) };
  }
  removeListener<E extends keyof VideoPlayerEvents>(eventName: E, listener: VideoPlayerEvents[E]): void {
    this.listeners.get(eventName)?.delete(listener as Listener);
  }
  removeAllListeners(eventName: keyof VideoPlayerEvents): void {
    this.listeners.delete(eventName);
  }
  emit<E extends keyof VideoPlayerEvents>(eventName: E, ...args: Parameters<VideoPlayerEvents[E]>): void {
    for (const l of [...(this.listeners.get(eventName) ?? [])]) l(...args);
  }
  listenerCount<E extends keyof VideoPlayerEvents>(eventName: E): number {
    return this.listeners.get(eventName)?.size ?? 0;
  }

  // ---------- engine switching (EngineView subscribes) ----------
  subscribeEngine = (l: () => void) => {
    this.engineListeners.add(l);
    return () => {
      this.engineListeners.delete(l);
    };
  };
  getEngine = () => this.engine;
  onMpvFirstFrame = (l: () => void) => {
    this.firstFrameListeners.add(l);
    return () => {
      this.firstFrameListeners.delete(l);
    };
  };
  /** Native players to render (EngineView), stable between changes. */
  getViews = () => this.views;
  /** mpv surfaces to render (EngineView), stable between changes. */
  getMpvSlots = () => this.slots;
  isMainSlot = (slot: number) => slot === this.mainSlot;

  /** Handlers of one mpv surface, routed to the visible player or to the hidden warm one. */
  mpvSlot(slot: number): MpvSlotProps {
    const known = this.slotProps.get(slot);
    if (known) return known;
    const route =
      <A extends unknown[]>(main: (...a: A) => void, stage: (st: MpvStage, ...a: A) => void) =>
      (...a: A) => {
        if (slot === this.mainSlot) return main(...a);
        const st = this.mpvStage;
        if (st && st.slot === slot) stage(st, ...a);
      };
    const p: MpvSlotProps = {
      ref: route(
        (h: MpvViewHandle | null) => this.attachView(h),
        (st, h: MpvViewHandle | null) => {
          st.view = h;
          if (!h) st.viewReady = false;
          this.startStage(st);
        },
      ),
      onReady: route(
        () => this.viewDidMount(),
        (st) => {
          st.viewReady = true;
          this.startStage(st);
        },
      ),
      onLoaded: route(
        (e: { nativeEvent: MpvLoadedEvent }) => this.mpv.onLoaded(e),
        (st, e: { nativeEvent: MpvLoadedEvent }) => this.stageLoaded(st, e.nativeEvent),
      ),
      onProgress: route(
        (e: { nativeEvent: MpvProgressEvent }) => this.mpv.onProgress(e),
        (st, e: { nativeEvent: MpvProgressEvent }) => {
          st.time = e.nativeEvent.time;
          if (e.nativeEvent.duration > 0) st.duration = e.nativeEvent.duration;
          st.buffered = e.nativeEvent.buffered;
        },
      ),
      onStateChange: route(
        (e: { nativeEvent: MpvStateEvent }) => this.mpv.onStateChange(e),
        (st, e: { nativeEvent: MpvStateEvent }) => {
          const n = e.nativeEvent;
          if (n.firstFrame) st.firstFrame = true;
          if (n.seeking != null) st.seeking = n.seeking;
          if (n.hwdec != null) {
            st.hwdec = n.hwdec;
            st.videoCodec = n.videoCodec ?? st.videoCodec;
          }
          if (n.width && n.height) st.size = { width: n.width, height: n.height };
        },
      ),
      onTracks: route(
        (e: { nativeEvent: { tracks: string } }) => this.mpv.onTracks(e),
        (st, e: { nativeEvent: { tracks: string } }) => {
          st.tracks = parseTracks(e.nativeEvent.tracks);
        },
      ),
      onEnd: route(
        () => this.mpv.onEnd(),
        () => {},
      ),
      onMpvError: route(
        (e: { nativeEvent: { message: string } }) => this.mpv.onMpvError(e),
        (st) => {
          st.error = true;
        },
      ),
    };
    this.slotProps.set(slot, p);
    return p;
  }

  private notifyViews() {
    this.engineListeners.forEach((l) => l());
  }

  private setEngine(engine: Engine, reason: string) {
    const changed = engine !== this.engine;
    this.engine = engine;
    this.reason = reason;
    if (engine === 'native') this.detail = '';
    this.publish();
    if (changed) this.engineListeners.forEach((l) => l());
  }

  private publish() {
    setActiveEngine(this, { engine: this.engine, reason: this.reason, detail: this.detail });
  }

  private viewReady = false;

  /** Callback ref of the mpv native view. */
  attachView = (v: MpvViewHandle | null) => {
    this.view = v;
    if (!v) this.viewReady = false;
    this.flushWaiters();
  };

  /** `onReady` of the native view: mounted (Fabric mounts after the ref is attached). */
  viewDidMount = () => {
    this.viewReady = true;
    if (this.fill) this.view?.setFill(true).catch(() => {});
    this.flushWaiters();
  };

  private flushWaiters() {
    const v = this.view;
    if (!v || !this.viewReady) return;
    const waiters = this.viewWaiters;
    this.viewWaiters = [];
    waiters.forEach((w) => w(v));
  }

  /** Resolves null when the player is released before the mpv view mounts (no leaked waiter). */
  private waitForView(): Promise<MpvViewHandle | null> {
    if (this.view && this.viewReady) return Promise.resolve(this.view);
    return new Promise((resolve) => this.viewWaiters.push(resolve));
  }

  // ---------- VideoPlayer surface used by Player.tsx ----------
  get currentTime(): number {
    return this.engine === 'mpv' ? this.m.time : this.native.currentTime;
  }
  set currentTime(t: number) {
    if (this.engine !== 'mpv') {
      this.native.currentTime = t;
      return;
    }
    // The resume position the file was opened at (`loadMpv` start): already there or on its way.
    const opened = this.mpvStart;
    this.mpvStart = 0;
    if (opened > 0 && Math.abs(t - opened) < 1) return;
    if (Math.abs(t - this.m.time) < 0.25) return;
    this.m.time = t;
    this.view?.seek(t).catch(() => {});
  }
  get duration(): number {
    return this.engine === 'mpv' ? this.m.duration : this.native.duration;
  }
  get playing(): boolean {
    return this.engine === 'mpv' ? !this.m.paused : this.native.playing;
  }
  get status(): VideoPlayerStatus {
    return this.engine === 'mpv' ? this.m.status : this.native.status;
  }
  get bufferedPosition(): number {
    return this.engine === 'mpv' ? this.m.buffered : this.native.bufferedPosition;
  }
  get volume(): number {
    return this.engine === 'mpv' ? this.vol : this.native.volume;
  }
  set volume(v: number) {
    this.vol = v;
    if (this.engine === 'mpv') this.view?.setVolume(v).catch(() => {});
    else this.native.volume = v;
  }
  get playbackRate(): number {
    return this.engine === 'mpv' ? this.rate : this.native.playbackRate;
  }
  set playbackRate(r: number) {
    this.rate = r;
    this.native.playbackRate = r;
    if (this.engine === 'mpv') this.view?.setSpeed(r).catch(() => {});
  }
  get availableAudioTracks(): AudioTrack[] {
    return this.engine === 'mpv' ? this.m.audio : this.native.availableAudioTracks;
  }
  get availableSubtitleTracks(): SubtitleTrack[] {
    return this.engine === 'mpv' ? this.m.subs : this.native.availableSubtitleTracks;
  }
  get videoTrack(): VideoTrack | null {
    return this.engine === 'mpv' ? this.m.videoTrack : this.native.videoTrack;
  }
  get audioTrack(): AudioTrack | null {
    return this.engine === 'mpv' ? this.m.audioTrack : this.native.audioTrack;
  }
  set audioTrack(t: AudioTrack | null) {
    if (this.engine !== 'mpv') {
      this.native.audioTrack = t;
      return;
    }
    const old = this.m.audioTrack;
    this.m.audioTrack = t;
    this.view?.setAudioTrack(mpvId(t)).catch(() => {});
    this.emit('audioTrackChange', { audioTrack: t, oldAudioTrack: old } as never);
  }
  get subtitleTrack(): SubtitleTrack | null {
    return this.engine === 'mpv' ? this.m.subtitleTrack : this.native.subtitleTrack;
  }
  set subtitleTrack(t: SubtitleTrack | null) {
    if (this.engine !== 'mpv') {
      this.native.subtitleTrack = t;
      return;
    }
    // "No embedded track" while libass draws the external file: that file stays selected.
    if (!t && this.extSub) {
      const old = this.m.subtitleTrack;
      this.m.subtitleTrack = null;
      if (old) this.emit('subtitleTrackChange', { subtitleTrack: null, oldSubtitleTrack: old });
      return;
    }
    if (mpvId(t) === mpvId(this.m.subtitleTrack)) return;
    const old = this.m.subtitleTrack;
    this.m.subtitleTrack = t;
    this.view?.setSubtitleTrack(mpvId(t)).catch(() => {});
    this.emit('subtitleTrackChange', { subtitleTrack: t, oldSubtitleTrack: old });
  }

  // ---------- subtitles drawn by mpv ----------

  /** The user's subtitle look and sync offset (see mpv-subtitles.ts), applied to every mpv file. */
  setMpvSubtitleOptions(opts: Record<string, string>) {
    const changed = Object.entries(opts).filter(([k, v]) => this.subOpts[k] !== v);
    this.subOpts = { ...opts };
    if (this.engine !== 'mpv' || !this.view) return;
    for (const [k, v] of changed) quiet(this.view.setSubtitleOption?.(k, v));
  }

  /** Whether this mpv build can draw a subtitle file itself (libass). */
  canDrawSubtitleFiles(): boolean {
    return deviceCaps().mpvAvailable && (!this.view || typeof this.view.addSubtitleFile === 'function');
  }

  /**
   * Local subtitle file (styled ASS) that mpv draws with libass, instead of the overlay; null to
   * go back to the embedded track chosen (or none). Kept across loads: re-added to each new file.
   */
  setMpvSubtitleFile(file: { path: string; lang: string } | null) {
    if (file?.path === this.extSub?.path) return;
    this.extSub = file;
    const view = this.view;
    if (this.engine !== 'mpv' || !view || !this.mpvLoaded) return;
    if (this.extSubId >= 0) quiet(view.removeSubtitle?.(this.extSubId));
    this.extSubId = -1;
    if (file) quiet(view.addSubtitleFile?.(file.path, EXT_SUB_TITLE, file.lang));
    else view.setSubtitleTrack(mpvId(this.m.subtitleTrack)).catch(() => {});
  }

  /** Zoom to fill (mpv: panscan). The native engine zooms through VideoView `contentFit`. */
  private fill = false;
  setFill(fill: boolean) {
    this.fill = fill;
    if (this.engine === 'mpv') this.view?.setFill(fill).catch(() => {});
  }

  play() {
    if (this.engine === 'mpv') this.view?.setPaused(false).catch(() => {});
    else this.native.play();
  }
  pause() {
    if (this.engine === 'mpv') this.view?.setPaused(true).catch(() => {});
    else this.native.pause();
  }

  /**
   * `startAt` (s): resume position. mpv opens the file there directly (`start`), instead of
   * decoding the beginning and seeking after the load (a second request, other pieces to wait for
   * on a torrent); the native engine is still positioned by the caller after the load.
   */
  async replaceAsync(source: VideoSource, opts?: { startAt?: number }): Promise<void> {
    const token = ++this.token;
    this.abortStage();
    this.settlePending();
    const src = typeof source === 'string' ? { uri: source } : source && typeof source === 'object' && source.uri ? (source as Src) : null;
    this.src = src;
    this.fallbackTried = null;
    if (!src) {
      this.setEngine('native', '');
      return this.native.replaceAsync(source);
    }

    const pref = getEnginePref();
    const c = deviceCaps();
    const probe = pref === 'auto' && c.mpvAvailable ? await probeSource(src.uri, src.headers) : null;
    if (token !== this.token) return;
    const d = decideEngine(pref, c, probe);

    if (d.engine === 'mpv') {
      if (this.engine === 'native') await this.native.replaceAsync(null).catch(() => {});
      const at = opts?.startAt;
      return this.loadMpv(src, d.reason, at && at > 1 ? at : 0, token);
    }
    this.setEngine('native', d.reason);
    this.armWatchdog(token);
    try {
      await this.native.replaceAsync(source);
    } catch (e) {
      if (token === this.token && this.canFallback()) return this.fallback(token);
      throw e;
    }
  }

  release() {
    this.token++;
    const waiters = this.viewWaiters;
    this.viewWaiters = [];
    waiters.forEach((w) => w(null));
    this.clearWatchdog();
    this.settlePending();
    this.abortStage();
    this.nativeSubs.forEach((s) => s.remove());
    this.nativeSubs = [];
    if (this.ownsNative) releaseLater(this.native);
    this.view?.stop().catch(() => {});
    setActiveEngine(this, null);
  }

  // ---------- warm player handover (pre-search / next-episode prefetch) ----------

  /**
   * Plays `src` with a player that already opened it hidden (./warm-pool.ts) instead of loading
   * it again: buffer, connection and redirects are kept. False when the source would not play on
   * the native engine (the caller then loads it normally and releases the warm player).
   */
  adoptWarm(next: VideoPlayer, src: Src): boolean {
    const pref = getEnginePref();
    const c = deviceCaps();
    const probe = pref === 'auto' && c.mpvAvailable ? cachedProbe(src.uri) ?? null : null;
    // Unknown container with mpv around: let replaceAsync probe it.
    if (pref === 'auto' && c.mpvAvailable && !probe) return false;
    const d = decideEngine(pref, c, probe);
    if (d.engine !== 'native' || next.status === 'error') return false;
    const token = ++this.token;
    this.abortStage();
    this.settlePending();
    this.clearWatchdog();
    const wasMpv = this.engine === 'mpv';
    const old = this.native;
    const oldOwned = this.ownsNative;
    const oldStatus = this.status;
    try {
      next.playbackRate = this.rate;
      next.volume = this.vol;
      next.timeUpdateEventInterval = old.timeUpdateEventInterval;
      next.muted = old.muted;
      next.allowsExternalPlayback = true;
      next.showNowPlayingNotification = true;
      next.bufferOptions = old.bufferOptions;
    } catch {
      // a property less is fine
    }
    this.nativeSubs.forEach((s) => s.remove());
    this.nativeSubs = [];
    try {
      old.pause();
    } catch {
      // released
    }
    if (wasMpv) this.view?.stop().catch(() => {});
    this.native = next;
    this.ownsNative = true;
    this.src = src;
    this.fallbackTried = null;
    this.forward(next);
    this.views = [next];
    this.setEngine('native', d.reason);
    this.notifyViews();
    this.armWatchdog(token);
    if (next.status === 'readyToPlay') this.clearWatchdog();
    // The events of a source load (already loaded while warm), after the caller's listeners are
    // in place (the handover happens during the first effects of the watch screen).
    queueMicrotask(() => {
      if (token !== this.token || this.native !== next) return;
      if (next.status === 'readyToPlay') {
        this.emit('sourceLoad', {
          videoSource: src as VideoSource,
          duration: next.duration,
          availableVideoTracks: next.availableVideoTracks,
          availableSubtitleTracks: next.availableSubtitleTracks,
          availableAudioTracks: next.availableAudioTracks,
        });
        if (next.videoTrack) this.emit('videoTrackChange', { videoTrack: next.videoTrack, oldVideoTrack: null });
      }
      this.emit('statusChange', { status: next.status, oldStatus });
    });
    if (oldOwned) releaseLater(old);
    else setTimeout(() => old.replaceAsync(null).catch(() => {}), RELEASE_DELAY_MS);
    return true;
  }

  // ---------- seamless source upgrade (native engine only) ----------

  /**
   * Opens `src` in a hidden, muted native player rendered under the visible one, or returns null
   * when the current engine is not the native one. The caller parks it at the right position and
   * calls `commitStage` once it is ready (see seamless-upgrade.ts).
   */
  stage(src: Src, leadS = 8): StagedPlayer | null {
    if (this.engine === 'mpv') return this.stageMpv(src, leadS);
    if (this.engine !== 'native') return null;
    this.abortStage();
    const p = createVideoPlayer({ uri: src.uri, headers: src.headers, metadata: src.metadata as never });
    p.muted = true;
    p.showNowPlayingNotification = false;
    p.allowsExternalPlayback = false;
    p.bufferOptions = { preferredForwardBufferDuration: 20 };
    this.staged = { player: p, src };
    this.views = [p, this.native];
    this.notifyViews();
    return p;
  }

  get stagedPlayer(): StagedPlayer | null {
    return this.staged?.player ?? this.mpvStage?.facade ?? null;
  }

  /** Whether a source can be warmed for a seamless switch with the engine in use. */
  canStage(): boolean {
    return this.engine === 'native' || (this.engine === 'mpv' && deviceCaps().mpvAvailable);
  }

  abortStage() {
    this.abortMpvStage();
    const st = this.staged;
    if (!st) return;
    this.staged = null;
    this.views = [this.native];
    this.notifyViews();
    try {
      st.player.pause();
    } catch {
      // already released
    }
    releaseLater(st.player);
  }

  /**
   * The staged player becomes the visible one: same rate, volume and audio language, playing if
   * the old one was; the old one is paused under it and released. Player.tsx gets the events of
   * a source load (tracks, duration) without any reload.
   */
  commitStage(): boolean {
    if (this.engine === 'mpv') return this.commitMpvStage();
    const st = this.staged;
    if (!st || this.engine !== 'native') return false;
    const next = st.player;
    const old = this.native;
    const oldOwned = this.ownsNative;
    const wasPlaying = old.playing;
    const oldStatus = old.status;
    const audioLang = old.audioTrack?.language;
    this.staged = null;
    this.clearWatchdog();

    try {
      next.playbackRate = this.rate;
      next.volume = old.volume;
      next.timeUpdateEventInterval = old.timeUpdateEventInterval;
      if (audioLang) {
        const t = next.availableAudioTracks.find((a) => a.language === audioLang);
        if (t && t.id !== next.audioTrack?.id) next.audioTrack = t;
      }
      next.muted = old.muted;
      next.allowsExternalPlayback = true;
      next.showNowPlayingNotification = true;
      if (wasPlaying) next.play();
    } catch {
      // keep going: the swap itself matters more than a property
    }
    this.nativeSubs.forEach((s) => s.remove());
    this.nativeSubs = [];
    try {
      old.pause();
      old.muted = true;
      old.showNowPlayingNotification = false;
    } catch {
      // released
    }
    this.native = next;
    this.ownsNative = true;
    this.src = st.src;
    this.fallbackTried = null;
    this.forward(next);
    this.views = [next];
    this.notifyViews();

    this.emit('sourceLoad', {
      videoSource: st.src as VideoSource,
      duration: next.duration,
      availableVideoTracks: next.availableVideoTracks,
      availableSubtitleTracks: next.availableSubtitleTracks,
      availableAudioTracks: next.availableAudioTracks,
    });
    this.emit('statusChange', { status: next.status, oldStatus });
    this.emit('playingChange', { isPlaying: wasPlaying, oldIsPlaying: wasPlaying });
    this.emit('audioTrackChange', { audioTrack: next.audioTrack, oldAudioTrack: old.audioTrack } as never);
    if (next.videoTrack) this.emit('videoTrackChange', { videoTrack: next.videoTrack, oldVideoTrack: old.videoTrack });

    // The old view unmounts on the next render: free the old player after that.
    if (oldOwned) releaseLater(old);
    else setTimeout(() => old.replaceAsync(null).catch(() => {}), RELEASE_DELAY_MS);
    return true;
  }

  // ---------- seamless source switch (mpv: a second, hidden mpv view) ----------

  /**
   * Opens `src` in a second libmpv view rendered under the visible one: muted, paused, opened a
   * little ahead of the playhead. The caller parks it precisely (`facade.currentTime = t`) and
   * calls `commitStage` when the visible player reaches that point.
   */
  private stageMpv(src: Src, leadS: number): StagedPlayer | null {
    if (!deviceCaps().mpvAvailable) return null;
    this.abortMpvStage();
    const slot = this.nextSlot++;
    const st: MpvStage = {
      slot,
      src,
      view: null,
      viewReady: false,
      started: false,
      loaded: false,
      firstFrame: false,
      seeking: false,
      error: false,
      start: Math.max(0, this.m.time + leadS * Math.max(1, this.rate)),
      time: 0,
      duration: 0,
      buffered: -1,
      tracks: [],
      videoCodec: '',
      hwdec: '',
      size: null,
      facade: null as unknown as StagedPlayer,
    };
    st.facade = {
      get status(): VideoPlayerStatus {
        if (st.error) return 'error';
        return st.loaded && st.firstFrame && !st.seeking ? 'readyToPlay' : 'loading';
      },
      get currentTime() {
        return st.time;
      },
      set currentTime(t: number) {
        // Precise seek (mpv is back to `hr-seek=default` after the first frame): the frame shown
        // when it takes over is the one the visible player is about to reach.
        if (!st.view || !st.firstFrame) return;
        st.seeking = true;
        st.time = t;
        st.view.seek(t).catch(() => {});
      },
      // A paused mpv reports no progress: the caller waits a settle time instead.
      get bufferedPosition() {
        return -1;
      },
      get duration() {
        return st.duration;
      },
    };
    this.mpvStage = st;
    this.slots = [...this.slots, slot];
    this.notifyViews();
    return st.facade;
  }

  private startStage(st: MpvStage) {
    if (st.started || !st.view || !st.viewReady || this.mpvStage !== st) return;
    st.started = true;
    const view = st.view;
    view.setVolume(0).catch(() => {});
    view.setSpeed(this.rate).catch(() => {});
    if (this.fill) view.setFill(true).catch(() => {});
    view
      .load(st.src.uri, st.src.headers ?? {}, st.start, false)
      .then(() => {
        for (const [k, v] of Object.entries(this.subOpts)) quiet(view.setSubtitleOption?.(k, v));
      })
      .catch(() => {
        st.error = true;
      });
  }

  private stageLoaded(st: MpvStage, e: MpvLoadedEvent) {
    st.loaded = true;
    st.duration = e.duration;
    st.tracks = parseTracks(e.tracks);
    st.videoCodec = e.videoCodec;
    st.hwdec = e.hwdec;
    // Another cut of the episode (other length): the swap would jump. Not seamless.
    const main = this.m.duration;
    if (main > 0 && e.duration > 0 && Math.abs(main - e.duration) > TIMELINE_TOLERANCE_S) st.error = true;
    // The styled subtitle file drawn by libass follows the file (mpv drops it at each load).
    if (this.extSub && st.view) quiet(st.view.addSubtitleFile?.(this.extSub.path, EXT_SUB_TITLE, this.extSub.lang));
  }

  private abortMpvStage() {
    const st = this.mpvStage;
    if (!st) return;
    this.mpvStage = null;
    this.slotProps.delete(st.slot);
    this.slots = this.slots.filter((x) => x !== st.slot);
    st.view?.stop().catch(() => {});
    this.notifyViews();
  }

  /**
   * The hidden mpv view becomes the visible one: the user's volume, speed and zoom, same audio
   * and subtitle languages, playing if the old one was. The old view is paused, then unmounted
   * (EngineView stops its libmpv). Player.tsx gets the events of a source load, without a reload.
   */
  private commitMpvStage(): boolean {
    const st = this.mpvStage;
    if (!st || !st.view || !st.loaded || !st.firstFrame || st.error || st.seeking) return false;
    const view = st.view;
    const old = this.m;
    const oldView = this.view;
    const oldSlot = this.mainSlot;
    const wasPlaying = !old.paused;
    view.setVolume(this.vol).catch(() => {});
    view.setSpeed(this.rate).catch(() => {});
    view.setFill(this.fill).catch(() => {});
    const audio = st.tracks.filter((t) => t.type === 'audio');
    const subs = st.tracks.filter((t) => t.type === 'sub' && !(t.external && t.title === EXT_SUB_TITLE));
    const wantAudio = old.audioTrack?.language;
    const pickAudio = (wantAudio ? audio.find((t) => normLang(t.lang) === wantAudio) : undefined) ?? audio.find((t) => t.selected) ?? null;
    if (pickAudio && !pickAudio.selected) view.setAudioTrack(pickAudio.id).catch(() => {});
    const wantSub = !this.extSub ? old.subtitleTrack?.language : undefined;
    const pickSub = wantSub ? (subs.find((t) => normLang(t.lang) === wantSub) ?? null) : null;
    if (pickSub) view.setSubtitleTrack(pickSub.id).catch(() => {});
    if (wasPlaying) view.setPaused(false).catch(() => {});
    if (oldView) {
      oldView.setPaused(true).catch(() => {});
      oldView.setVolume(0).catch(() => {});
    }

    this.mpvStage = null;
    this.clearWatchdog();
    this.view = view;
    this.viewReady = true;
    this.mainSlot = st.slot;
    this.slotProps.delete(oldSlot);
    this.slots = [st.slot];
    this.src = st.src;
    this.fallbackTried = null;
    this.mpvStart = 0;
    this.mpvLoaded = true;
    const m = freshMpv();
    m.status = 'readyToPlay';
    m.time = st.time;
    m.duration = st.duration;
    m.buffered = Math.max(st.time, st.buffered);
    m.paused = !wasPlaying;
    m.audio = old.audio;
    m.subs = old.subs;
    m.videoTrack = st.size
      ? { id: 'mpv:video', url: null, size: st.size, mimeType: null, isSupported: true, bitrate: null, averageBitrate: null, peakBitrate: null, frameRate: null, videoRange: 'sdr' }
      : old.videoTrack;
    this.m = m;
    this.applyTracks(st.tracks);
    if (pickAudio) this.m.audioTrack = toTrack(pickAudio);
    if (pickSub) this.m.subtitleTrack = toTrack(pickSub);
    this.notifyViews();
    this.setDetail(st.videoCodec, st.hwdec);

    this.emit('sourceLoad', {
      videoSource: st.src as VideoSource,
      duration: st.duration,
      availableVideoTracks: [],
      availableSubtitleTracks: this.m.subs,
      availableAudioTracks: this.m.audio,
    });
    this.emit('statusChange', { status: 'readyToPlay', oldStatus: old.status });
    this.emit('playingChange', { isPlaying: wasPlaying, oldIsPlaying: wasPlaying });
    this.emit('audioTrackChange', { audioTrack: this.m.audioTrack, oldAudioTrack: old.audioTrack } as never);
    if (this.m.videoTrack) this.emit('videoTrackChange', { videoTrack: this.m.videoTrack, oldVideoTrack: old.videoTrack });
    return true;
  }

  // ---------- native engine ----------
  private onNativeEvent(name: (typeof FORWARDED)[number], args: unknown[]) {
    if (this.engine !== 'native') return;
    if (name === 'statusChange') {
      const p = args[0] as { status: VideoPlayerStatus };
      if (p.status === 'readyToPlay') this.clearWatchdog();
      if (p.status === 'error' && this.canFallback()) {
        void this.fallback(this.token).catch(() => {});
        return;
      }
    }
    (this.emit as (n: string, ...a: unknown[]) => void)(name, ...args);
  }

  private watchdog: ReturnType<typeof setTimeout> | null = null;

  /**
   * AVPlayer sometimes never errors on a source it cannot read (e.g. a server ignoring Range
   * requests): it just stays "loading". Past NATIVE_LOAD_TIMEOUT without a first frame, mpv takes over.
   */
  private armWatchdog(token: number) {
    this.clearWatchdog();
    if (!this.canFallback()) return;
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (token === this.token && this.engine === 'native' && this.native.status === 'loading' && this.canFallback()) {
        void this.fallback(token).catch(() => {});
      }
    }, NATIVE_LOAD_TIMEOUT);
  }

  private clearWatchdog() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private canFallback() {
    const c = deviceCaps();
    return !!this.src && getEnginePref() === 'auto' && c.mpvAvailable && this.fallbackTried !== this.src.uri;
  }

  /** The native engine failed on this source: same source, same position, with mpv. */
  private async fallback(token: number) {
    this.clearWatchdog();
    const src = this.src!;
    this.fallbackTried = src.uri;
    const at = this.native.currentTime;
    this.native.pause();
    await this.native.replaceAsync(null).catch(() => {});
    if (token !== this.token) return;
    return this.loadMpv(src, 'échec du lecteur natif', at > 1 ? at : 0, token);
  }

  // ---------- mpv engine ----------
  private async loadMpv(src: Src, reason: string, start: number, token: number): Promise<void> {
    const old = this.m;
    this.m = freshMpv();
    this.m.time = start;
    this.mpvStart = start;
    this.mpvLoaded = false;
    this.extSubId = -1;
    this.detail = '';
    this.setEngine('mpv', reason);
    this.emit('statusChange', { status: 'loading', oldStatus: old.status });
    if (old.audio.length) this.emit('availableAudioTracksChange', { availableAudioTracks: [], oldAvailableAudioTracks: old.audio } as never);
    const view = await this.waitForView();
    if (!view) return;
    if (token !== this.token) return;
    const loaded = new Promise<void>((resolve) => {
      this.pending = { resolve };
    });
    view.setSpeed(this.rate).catch(() => {});
    view.setVolume(this.vol).catch(() => {});
    try {
      await view.load(src.uri, src.headers ?? {}, start, true);
      for (const [k, v] of Object.entries(this.subOpts)) quiet(view.setSubtitleOption?.(k, v));
    } catch (e) {
      this.mpv.onMpvError({ nativeEvent: { message: e instanceof Error ? e.message : 'mpv indisponible' } });
    }
    return loaded;
  }

  /** A superseded load resolves silently (Player.tsx ignores results of stale loads). */
  private settlePending() {
    const p = this.pending;
    this.pending = null;
    p?.resolve();
  }

  private setStatus(status: VideoPlayerStatus, error?: string) {
    const oldStatus = this.m.status;
    if (oldStatus === status && !error) return;
    this.m.status = status;
    this.emit('statusChange', { status, oldStatus, error: error ? { message: error } : undefined });
  }

  private setPaused(paused: boolean) {
    if (paused === this.m.paused) return;
    this.m.paused = paused;
    this.emit('playingChange', { isPlaying: !paused, oldIsPlaying: paused });
  }

  private applyTracks(tracks: MpvTrack[]) {
    const oldAudio = this.m.audio;
    const oldSubs = this.m.subs;
    const audio = tracks.filter((t) => t.type === 'audio');
    // The external file drawn by libass is not one of the video's tracks.
    const ext = tracks.find((t) => t.type === 'sub' && t.external && t.title === EXT_SUB_TITLE);
    this.extSubId = ext ? ext.id : -1;
    const subs = tracks.filter((t) => t.type === 'sub' && t !== ext);
    this.m.audio = audio.map(toTrack);
    this.m.subs = subs.map(toTrack);
    const selA = audio.find((t) => t.selected);
    this.m.audioTrack = selA ? toTrack(selA) : null;
    const selS = subs.find((t) => t.selected);
    this.m.subtitleTrack = selS ? toTrack(selS) : null;
    const key = (l: { id?: string }[]) => l.map((t) => t.id).join(',');
    if (key(oldAudio) !== key(this.m.audio)) this.emit('availableAudioTracksChange', { availableAudioTracks: this.m.audio, oldAvailableAudioTracks: oldAudio } as never);
    if (key(oldSubs) !== key(this.m.subs)) this.emit('availableSubtitleTracksChange', { availableSubtitleTracks: this.m.subs, oldAvailableSubtitleTracks: oldSubs });
  }

  /** Event handlers for the mpv native view (EngineView). */
  readonly mpv = {
    onLoaded: (e: { nativeEvent: MpvLoadedEvent }) => {
      const { duration, videoCodec, hwdec } = e.nativeEvent;
      const tracks = parseTracks(e.nativeEvent.tracks);
      this.m.duration = duration;
      this.mpvLoaded = true;
      this.applyTracks(tracks);
      if (this.extSub && this.view) quiet(this.view.addSubtitleFile?.(this.extSub.path, EXT_SUB_TITLE, this.extSub.lang));
      this.pickDefaultAudio(tracks);
      this.setDetail(videoCodec, hwdec);
      this.emit('sourceLoad', {
        videoSource: (this.src ?? null) as VideoSource,
        duration,
        availableVideoTracks: [],
        availableSubtitleTracks: this.m.subs,
        availableAudioTracks: this.m.audio,
      });
      this.emit('audioTrackChange', { audioTrack: this.m.audioTrack } as never);
      this.setStatus('readyToPlay');
      const p = this.pending;
      this.pending = null;
      p?.resolve();
    },
    onProgress: (e: { nativeEvent: MpvProgressEvent }) => {
      const { time, duration, buffered, paused } = e.nativeEvent;
      this.m.time = time;
      if (duration > 0) this.m.duration = duration;
      this.m.buffered = buffered;
      this.setPaused(paused);
      this.emit('timeUpdate', { currentTime: time, currentLiveTimestamp: null, currentOffsetFromLive: null, bufferedPosition: buffered });
    },
    onStateChange: (e: { nativeEvent: MpvStateEvent }) => {
      const s = e.nativeEvent;
      if (s.firstFrame) this.firstFrameListeners.forEach((l) => l());
      if (s.paused != null) this.setPaused(s.paused);
      if (s.buffering != null) {
        this.m.buffering = s.buffering;
        if (this.m.status !== 'error' && this.m.status !== 'idle') this.setStatus(s.buffering ? 'loading' : 'readyToPlay');
      }
      if (s.hwdec != null) this.setDetail(s.videoCodec ?? '', s.hwdec);
      if (s.width && s.height) {
        const old = this.m.videoTrack;
        this.m.videoTrack = {
          id: 'mpv:video', url: null, size: { width: s.width, height: s.height }, mimeType: null, isSupported: true,
          bitrate: null, averageBitrate: null, peakBitrate: null, frameRate: null, videoRange: 'sdr',
        };
        this.emit('videoTrackChange', { videoTrack: this.m.videoTrack, oldVideoTrack: old });
      }
    },
    onTracks: (e: { nativeEvent: { tracks: string } }) => this.applyTracks(parseTracks(e.nativeEvent.tracks)),
    onEnd: () => {
      this.setPaused(true);
      this.emit('playToEnd');
    },
    onMpvError: (e: { nativeEvent: { message: string } }) => {
      const message = e.nativeEvent.message || 'Lecture impossible (mpv)';
      const p = this.pending;
      this.pending = null;
      // Player.tsx reports errors from statusChange; the load promise resolves so it is not reported twice.
      p?.resolve();
      this.setStatus('error', message);
    },
  };

  /**
   * Default audio track from the language settings (Réglages → Langues): in "VF" mode the first
   * dub language found, otherwise the file's default track (usually the original version).
   * Subtitles are chosen by the subtitle controller of the Player, as for the native engine.
   */
  private pickDefaultAudio(tracks: MpvTrack[]) {
    const audio = tracks.filter((t) => t.type === 'audio');
    if (audio.length < 2) return;
    const { watchMode, dubLangs } = getSettings();
    if (watchMode !== 'dub') return;
    for (const lang of dubLangs) {
      const t = audio.find((a) => normLang(a.lang) === lang);
      if (!t) continue;
      if (!t.selected) this.audioTrack = toTrack(t);
      return;
    }
  }

  private setDetail(codec: string, hwdec: string) {
    if (!codec) return;
    const name = codec.split(/[\s(]/)[0].toUpperCase();
    this.detail = `${name} · ${hwdec && hwdec !== 'no' ? 'décodage matériel' : 'décodage logiciel'}`;
    this.publish();
  }
}
