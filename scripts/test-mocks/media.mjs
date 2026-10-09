// Fake playback engines for the player lifecycle tests (src/components/player/engines/__tests__):
// an expo-video `VideoPlayer` and an mpv view handle that follow the native semantics the app
// relies on, with controllable load delays so the races of quick taps can be replayed.
//
// expo-video (iOS): `replaceAsync(src)` loads off the main thread then swaps the item; a newer
// `replaceAsync` cancels an older one, which then resolves without applying its source; `null`
// clears the item; `release()` pauses and clears. A player never plays on its own (`play()`).
//
// mpv view (modules/huwa-mpv): `load(..., autoplay)` replaces the file and plays at once when
// `autoplay`; `stop()` destroys the core (a later `load` creates a new one); file events come
// back through the HybridPlayer's `mpv.on…` handlers, wired by the test's surface stand-in.

/** Load time of a fake source (ms), per URI substring; default 10 ms. */
export const loadDelays = new Map();
const delayOf = (uri) => {
  for (const [k, v] of loadDelays) if (uri.includes(k)) return v;
  return 10;
};

/** Time a native `replaceAsync(null)` takes to clear the item (ms). */
export const timing = { clearMs: 1 };

/** Every fake native player created (warm, staged, the screen's own). */
export const videoPlayers = [];

export class FakeVideoPlayer {
  constructor(source) {
    this.uri = null;
    this.status = 'idle';
    this.playing = false;
    this.muted = false;
    this.volume = 1;
    this.playbackRate = 1;
    this.currentTime = 0;
    this.duration = 0;
    this.bufferedPosition = 0;
    this.released = false;
    this.timeUpdateEventInterval = 0;
    this.allowsExternalPlayback = true;
    this.showNowPlayingNotification = false;
    this.bufferOptions = {};
    this.availableAudioTracks = [];
    this.availableSubtitleTracks = [];
    this.availableVideoTracks = [];
    this.audioTrack = null;
    this.subtitleTrack = null;
    this.videoTrack = null;
    this.isExternalPlaybackActive = false;
    this.listeners = new Map();
    this.loadSeq = 0;
    videoPlayers.push(this);
    if (source?.uri) void this.replaceAsync(source);
  }

  /** Heard: playing a loaded item, not muted, not released. */
  get audible() {
    return !this.released && this.playing && !!this.uri && !this.muted;
  }

  addListener(name, fn) {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
    return { remove: () => set.delete(fn) };
  }

  emit(name, payload) {
    for (const fn of [...(this.listeners.get(name) ?? [])]) fn(payload);
  }

  setStatus(status) {
    const oldStatus = this.status;
    if (oldStatus === status) return;
    this.status = status;
    this.emit('statusChange', { status, oldStatus });
  }

  check() {
    if (this.released) throw new Error('FakeVideoPlayer: used after release');
  }

  replaceAsync(source) {
    this.check();
    const seq = ++this.loadSeq;
    const uri = typeof source === 'string' ? source : source?.uri ?? null;
    if (!uri) {
      // clearCurrentItem: the item goes away on the next main-thread turn.
      return new Promise((resolve) => setTimeout(() => {
        if (!this.released && seq === this.loadSeq) {
          this.uri = null;
          this.playing = false;
          this.setStatus('idle');
        }
        resolve();
      }, timing.clearMs));
    }
    this.setStatus('loading');
    return new Promise((resolve) => setTimeout(() => {
      // Cancelled by a newer replace (or the release): resolves without applying.
      if (!this.released && seq === this.loadSeq) {
        this.uri = uri;
        this.duration = 1440;
        this.setStatus('readyToPlay');
      }
      resolve();
    }, delayOf(uri)));
  }

  play() {
    this.check();
    if (!this.playing) {
      this.playing = true;
      this.emit('playingChange', { isPlaying: true, oldIsPlaying: false });
    }
  }

  pause() {
    this.check();
    if (this.playing) {
      this.playing = false;
      this.emit('playingChange', { isPlaying: false, oldIsPlaying: true });
    }
  }

  release() {
    this.released = true;
    this.playing = false;
    this.uri = null;
    this.listeners.clear();
  }
}

export function createVideoPlayer(source) {
  return new FakeVideoPlayer(source);
}

/** Every fake mpv view created. */
export const mpvViews = [];

/** mpv view handle; `host` receives the file events (HybridPlayer.mpv), set by the surface. */
/** mpv track list (MpvTrack[]) a file reports when it loads, by URL (default: none). */
export const fileTracks = new Map();

export class FakeMpvView {
  constructor() {
    this.file = null;
    this.paused = true;
    this.destroyed = false;
    this.cores = 0;
    this.calls = [];
    this.host = null;
    this.loadSeq = 0;
    mpvViews.push(this);
  }

  get audible() {
    return !this.destroyed && !!this.file && !this.paused;
  }

  call(name, ...args) {
    this.calls.push([name, ...args]);
    // A view function call crosses to the main thread and back.
    return new Promise((resolve) => setTimeout(resolve, 1));
  }

  load(url, _headers, _start, autoplay) {
    if (this.destroyed || !this.cores) {
      this.destroyed = false;
      this.cores++;
    }
    const seq = ++this.loadSeq;
    this.file = url;
    this.paused = !autoplay;
    setTimeout(() => {
      if (this.destroyed || seq !== this.loadSeq) return;
      this.host?.onLoaded({ nativeEvent: { duration: 1440, tracks: JSON.stringify(fileTracks.get(url) ?? []), videoCodec: 'hevc', hwdec: 'videotoolbox' } });
      this.host?.onProgress({ nativeEvent: { time: 0, duration: 1440, buffered: 5, paused: this.paused } });
    }, delayOf(url));
    return this.call('load', url, autoplay);
  }

  setPaused(paused) {
    if (!this.destroyed) this.paused = paused;
    return this.call('setPaused', paused);
  }

  seek(t) {
    return this.call('seek', t);
  }

  stop() {
    this.destroyed = true;
    this.file = null;
    this.paused = true;
    return this.call('stop');
  }

  setSpeed(v) { return this.call('setSpeed', v); }
  setVolume(v) { return this.call('setVolume', v); }
  setAudioTrack(id) { return this.call('setAudioTrack', id); }
  setAudioLanguages(l) { return this.call('setAudioLanguages', l); }
  setSubtitleTrack(id) { return this.call('setSubtitleTrack', id); }
  setFill(f) { return this.call('setFill', f); }
  setSubtitleOption(k, v) { return this.call('setSubtitleOption', k, v); }
  addSubtitleFile(p, t, l) { return this.call('addSubtitleFile', p, t, l); }
  removeSubtitle(id) { return this.call('removeSubtitle', id); }
}

export function resetMedia() {
  loadDelays.clear();
  fileTracks.clear();
  timing.clearMs = 1;
  videoPlayers.length = 0;
  mpvViews.length = 0;
}

// ---- modules/huwa-mpv binding (libmpv linked) and expo-file-system (local probe) ----

export const HuwaMpv = { mpvVersion: 'fake', isAvailable: () => true, hardwareDecoders: () => ({ hevc: true, h264: true }) };
export const getMpvNativeView = () => function FakeMpvNativeView() {
  return null;
};

export const FileSystem = {
  File: class {
    constructor() {
      this.exists = false;
    }
  },
};
