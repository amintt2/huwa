//! Playback orchestration on top of librqbit's `FileStream`s: read-ahead walker, container-index
//! prefetch, playhead / wait tracking for the HTTP server, swarm health and automatic recovery.
//!
//! How librqbit 9.0.1 picks pieces (read from `torrent_state/{streaming,live/mod}.rs`,
//! `piece_tracker.rs`): every open `FileStream` contributes a queue of the pieces covering
//! `[position, position + 32 MiB)`; the queues of all streams are interleaved (shuffled order) and
//! each peer takes the first piece of that list it has and nobody downloads yet; only then the
//! rest of the selected file in natural order. Slow in-flight pieces are stolen by faster peers
//! (10× / 3× the peer's average piece time) — the only "endgame" librqbit has, not configurable.
//! There is no per-piece priority or deadline API, so everything here is expressed with streams:
//!
//! - **Read-ahead walker** (one per playback): a `FileStream` that sits on the *first missing
//!   piece* after the playhead (it reads one byte per piece, which blocks until the piece is
//!   verified, then jumps to the next piece). Its 32 MiB queue therefore always starts at the
//!   download frontier, so the priority window slides past librqbit's fixed 32 MiB look-ahead of
//!   the serving stream, up to `readahead_target_bytes` ahead of the playhead; beyond the target
//!   the walker closes its stream (no priority, natural order resumes). A seek outside the
//!   current window aborts the walker and starts a new one at the new offset (stale window
//!   dropped at once instead of the 60 s helper streams of the previous policy).
//! - **Container index prefetch**: once per playback, the last `tail_prefetch_bytes` of the file
//!   (MP4 `moov` at the end, MKV Cues) are fetched alongside the head so the player's tail probe
//!   does not wait. Kept small: every extra stream halves the head's share of the priority list.
//! - **Health / recovery**: a 1 Hz monitor flags torrents with active streams as `searching`
//!   (no connected peer) or `stalled` (a player request waiting for data for > `STALL_AFTER`).
//!   When no peer is connected for `RECOVER_NO_PEERS_AFTER` or a stall lasts
//!   `RECOVER_STALL_AFTER`, the torrent is paused and resumed: librqbit then rebuilds its live
//!   state — new tracker announce (otherwise the next one is the tracker's interval, often 30 min),
//!   new DHT `get_peers`, and peer back-offs reset (dead peers wait 10 s, 60 s, 6 min, 36 min…).
//!   That is what brings a stream back after Wi-Fi ↔ cellular or a sleep that killed every socket.

use std::{
    collections::HashMap,
    io::SeekFrom,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, OnceLock, Weak,
    },
    task::Poll,
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt};
use tracing::{debug, info, warn};

use crate::{
    engine::{Engine, Entry, ManagedTorrentHandle},
    priorities::{readahead_target_bytes, tail_prefetch_bytes, PlaybackIntent},
};

/// Size of librqbit's blocking-work semaphore (`SessionOptions::runtime_worker_threads`).
/// Every open `FileStream` holds one permit for its whole life and `add_torrent` needs one: with
/// librqbit's default of 8, a player with a few open connections + helper streams + another
/// torrent starting blocked forever in `stream()` / `add_torrent`. The permits only bound
/// `block_in_place` sections (disk reads/writes of a few KiB to MiB), not threads.
pub const BLOCKING_PERMITS: usize = 64;
/// Outgoing peer connect timeout (librqbit default 10 s). Each dial holds one of the torrent's
/// `peer_limit` slots until it completes or times out; most addresses from DHT/trackers are dead,
/// so a shorter timeout churns through them several times faster. Live peers answer a TCP SYN in
/// well under a second even on cellular.
pub const PEER_CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
/// DHT routing-table dump interval (librqbit default 60 s): a first launch that is killed early
/// still leaves a table for a warm bootstrap next time.
pub const DHT_DUMP_INTERVAL: Duration = Duration::from_secs(20);
/// Bootstrap nodes (librqbit only ships the first two).
pub const DHT_BOOTSTRAP: &[&str] = &[
    "dht.transmissionbt.com:6881",
    "dht.libtorrent.org:25401",
    "router.bittorrent.com:6881",
    "router.utorrent.com:6881",
];

/// A player request blocked this long on a missing piece makes the torrent `stalled`.
pub const STALL_AFTER: Duration = Duration::from_secs(6);
/// Recovery (pause + resume) when no peer is connected for this long while streaming…
pub const RECOVER_NO_PEERS_AFTER: Duration = Duration::from_secs(12);
/// …or when a stall lasts this long without any downloaded byte.
pub const RECOVER_STALL_AFTER: Duration = Duration::from_secs(20);
/// Minimum delay between two recoveries of the same torrent (doubles up to the max).
const RECOVER_MIN_INTERVAL: Duration = Duration::from_secs(30);
const RECOVER_MAX_INTERVAL: Duration = Duration::from_secs(240);
/// A playback without any open HTTP response for this long is forgotten (walker stopped).
const PLAYBACK_IDLE_TTL: Duration = Duration::from_secs(90);
/// The walker re-evaluates the playhead at least this often while waiting for a piece.
const WALKER_TICK: Duration = Duration::from_secs(2);
const TAIL_BUDGET: Duration = Duration::from_secs(90);

fn now_ms() -> u64 {
    static BASE: OnceLock<Instant> = OnceLock::new();
    BASE.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// File geometry inside the torrent, enough to walk piece boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Geometry {
    pub file_offset: u64,
    pub file_len: u64,
    pub piece_len: u64,
}

impl Geometry {
    pub fn of(handle: &ManagedTorrentHandle, file_idx: usize) -> Option<Self> {
        handle
            .with_metadata(|m| {
                m.file_infos.get(file_idx).map(|f| Geometry {
                    file_offset: f.offset_in_torrent,
                    file_len: f.len,
                    piece_len: m.lengths().default_piece_length() as u64,
                })
            })
            .ok()
            .flatten()
            .filter(|g| g.piece_len > 0)
    }

    /// File offset where the piece after the one holding `pos` starts (clamped to the file end).
    pub fn next_piece_start(&self, pos: u64) -> u64 {
        let abs = self.file_offset + pos;
        let next_abs = (abs / self.piece_len + 1) * self.piece_len;
        (next_abs - self.file_offset).min(self.file_len)
    }
}

struct Walker {
    origin: u64,
    frontier: Arc<AtomicU64>,
    task: tokio::task::AbortHandle,
}

/// One playback of one file (a player session), shared by all its HTTP responses.
pub struct Playback {
    pub file_idx: usize,
    pub geometry: Geometry,
    /// Offset reached by the most recent playback response (not by tail probes).
    pub playhead: AtomicU64,
    /// Responses opened by the player (to tell the latest one, which owns the playhead).
    generation: AtomicU64,
    /// Responses currently blocked on a missing piece, and since when (`now_ms`, 0 = none).
    waiting: AtomicUsize,
    wait_since_ms: AtomicU64,
    open_responses: AtomicUsize,
    last_activity_ms: AtomicU64,
    tail_started: AtomicBool,
    walker: Mutex<Option<Walker>>,
}

impl Playback {
    fn new(file_idx: usize, geometry: Geometry) -> Self {
        Self {
            file_idx,
            geometry,
            playhead: AtomicU64::new(0),
            generation: AtomicU64::new(0),
            waiting: AtomicUsize::new(0),
            wait_since_ms: AtomicU64::new(0),
            open_responses: AtomicUsize::new(0),
            last_activity_ms: AtomicU64::new(now_ms()),
            tail_started: AtomicBool::new(false),
            walker: Mutex::new(None),
        }
    }

    /// How long the oldest blocked response has been waiting.
    pub fn waiting_for(&self) -> Option<Duration> {
        if self.waiting.load(Ordering::Acquire) == 0 {
            return None;
        }
        let since = self.wait_since_ms.load(Ordering::Acquire);
        (since > 0).then(|| Duration::from_millis(now_ms().saturating_sub(since)))
    }

    pub fn frontier(&self) -> Option<u64> {
        self.walker.lock().as_ref().map(|w| w.frontier.load(Ordering::Relaxed))
    }

    fn stop_walker(&self) {
        if let Some(w) = self.walker.lock().take() {
            w.task.abort();
        }
    }
}

impl Drop for Playback {
    fn drop(&mut self) {
        if let Some(w) = self.walker.get_mut().take() {
            w.task.abort();
        }
    }
}

#[derive(Debug, Clone, Default)]
struct HealthState {
    no_peers_since_ms: u64,
    last_progress_bytes: u64,
    last_progress_ms: u64,
    last_recovery_ms: u64,
    recover_interval: Duration,
    recoveries: u32,
    label: &'static str,
}

/// Per-engine streaming state (`Engine::streaming`).
#[derive(Default)]
pub struct Streaming {
    playbacks: Mutex<HashMap<String, Arc<Playback>>>,
    health: Mutex<HashMap<String, HealthState>>,
}

impl Streaming {
    pub fn playback(&self, hex: &str) -> Option<Arc<Playback>> {
        self.playbacks.lock().get(hex).cloned()
    }

    /// `ok` | `searching` (streaming, no peer connected) | `stalled` (the player waits for data)
    /// | `recovering` (re-announce in progress) | `idle` (nothing streamed right now).
    pub fn health_of(&self, hex: &str) -> &'static str {
        self.health.lock().get(hex).map(|h| h.label).filter(|l| !l.is_empty()).unwrap_or("idle")
    }

    pub fn recoveries_of(&self, hex: &str) -> u32 {
        self.health.lock().get(hex).map(|h| h.recoveries).unwrap_or(0)
    }

    pub fn forget(&self, hex: &str) {
        self.playbacks.lock().remove(hex);
        self.health.lock().remove(hex);
    }

    /// Called by the HTTP server for every request, before the body is streamed. Returns the
    /// playback and the response generation (for `TrackedReader`).
    #[allow(clippy::too_many_arguments)]
    pub fn on_request(
        &self,
        runtime: &tokio::runtime::Runtime,
        hex: &str,
        handle: &ManagedTorrentHandle,
        file_idx: usize,
        start: u64,
        intent: PlaybackIntent,
        cache_limit_bytes: u64,
    ) -> Option<(Arc<Playback>, u64)> {
        let geometry = Geometry::of(handle, file_idx)?;
        let pb = {
            let mut map = self.playbacks.lock();
            let reuse = map.get(hex).filter(|p| p.file_idx == file_idx && p.geometry == geometry).cloned();
            match reuse {
                Some(p) => p,
                None => {
                    let p = Arc::new(Playback::new(file_idx, geometry));
                    if let Some(old) = map.insert(hex.to_string(), p.clone()) {
                        old.stop_walker();
                    }
                    p
                }
            }
        };
        pb.last_activity_ms.store(now_ms(), Ordering::Relaxed);

        let generation = match intent {
            // Tail probes and background reads neither move the playhead nor the walker.
            PlaybackIntent::ContainerMetadata | PlaybackIntent::Background => 0,
            _ => {
                let g = pb.generation.fetch_add(1, Ordering::AcqRel) + 1;
                pb.playhead.store(start, Ordering::Release);
                self.ensure_walker(runtime, &pb, handle, start, cache_limit_bytes);
                g
            }
        };

        if intent == PlaybackIntent::DirectInitial && !pb.tail_started.swap(true, Ordering::AcqRel) {
            let tail = tail_prefetch_bytes(geometry.file_len, geometry.piece_len);
            let tail_start = geometry.file_len.saturating_sub(tail);
            // Pointless when the tail is within the head's own 32 MiB look-ahead.
            if tail > 0 && tail_start > start.saturating_add(32 * 1024 * 1024) {
                let handle = handle.clone();
                runtime.spawn(async move {
                    let job = walk_pieces(handle, file_idx, geometry, tail_start, geometry.file_len);
                    match tokio::time::timeout(TAIL_BUDGET, job).await {
                        Ok(Ok(())) => debug!(tail_start, "container index prefetched"),
                        Ok(Err(e)) => debug!("tail prefetch failed: {e:#}"),
                        Err(_) => debug!("tail prefetch timed out"),
                    }
                });
            }
        }
        Some((pb, generation))
    }

    /// Keeps the current walker when `start` falls inside its window (sequential continuation),
    /// otherwise replaces it (seek): the stale window stops being prioritised immediately.
    fn ensure_walker(
        &self,
        runtime: &tokio::runtime::Runtime,
        pb: &Arc<Playback>,
        handle: &ManagedTorrentHandle,
        start: u64,
        cache_limit_bytes: u64,
    ) {
        let g = pb.geometry;
        let mut slot = pb.walker.lock();
        if let Some(w) = slot.as_ref() {
            let frontier = w.frontier.load(Ordering::Relaxed);
            if !w.task.is_finished() && w.origin <= start && start <= frontier.saturating_add(2 * g.piece_len) {
                return;
            }
            w.task.abort();
        }
        let frontier = Arc::new(AtomicU64::new(start));
        let target = readahead_target_bytes(g.file_len, cache_limit_bytes);
        let task = runtime.spawn(run_walker(handle.clone(), pb.file_idx, g, start, target, Arc::downgrade(pb), frontier.clone()));
        debug!(start, target, "read-ahead walker (re)started");
        *slot = Some(Walker { origin: start, frontier, task: task.abort_handle() });
    }
}

/// Reads one byte at every piece start in `[from, to)`: each read waits until the piece is
/// downloaded and verified, and while waiting the stream's 32 MiB queue (starting at that piece)
/// is in librqbit's priority list.
pub async fn walk_pieces(handle: ManagedTorrentHandle, file_idx: usize, g: Geometry, from: u64, to: u64) -> anyhow::Result<()> {
    let mut s = handle.stream(file_idx).await?;
    let mut pos = from;
    let mut byte = [0u8; 1];
    while pos < to.min(g.file_len) {
        s.seek(SeekFrom::Start(pos)).await?;
        if s.read(&mut byte).await? == 0 {
            break;
        }
        pos = g.next_piece_start(pos);
    }
    Ok(())
}

async fn run_walker(
    handle: ManagedTorrentHandle,
    file_idx: usize,
    g: Geometry,
    origin: u64,
    target_ahead: u64,
    pb: Weak<Playback>,
    frontier_out: Arc<AtomicU64>,
) {
    let mut stream = None;
    let mut frontier = origin;
    let mut byte = [0u8; 1];
    loop {
        let Some(playback) = pb.upgrade() else { return };
        if frontier >= g.file_len {
            return;
        }
        // The player may have read past the frontier (pieces downloaded in natural order).
        let playhead = playback.playhead.load(Ordering::Acquire).max(origin);
        drop(playback);
        if playhead > frontier {
            frontier = playhead;
        }
        if frontier - playhead >= target_ahead {
            // Enough buffered ahead: stop prioritising (natural order continues), re-check later.
            stream = None;
            tokio::time::sleep(WALKER_TICK).await;
            continue;
        }
        if stream.is_none() {
            match handle.clone().stream(file_idx).await {
                Ok(s) => stream = Some(s),
                Err(e) => {
                    debug!("walker cannot open stream: {e:#}");
                    tokio::time::sleep(WALKER_TICK).await;
                    continue;
                }
            }
        }
        let s = stream.as_mut().expect("opened above");
        if let Err(e) = s.seek(SeekFrom::Start(frontier)).await {
            debug!("walker seek failed: {e:#}");
            return;
        }
        match tokio::time::timeout(WALKER_TICK, s.read(&mut byte)).await {
            Ok(Ok(0)) => return,
            Ok(Ok(_)) => {
                frontier = g.next_piece_start(frontier);
                frontier_out.store(frontier, Ordering::Relaxed);
            }
            Ok(Err(e)) => {
                // Torrent paused / deleted under us: retry later (recovery pauses and resumes).
                debug!("walker read failed: {e:#}");
                stream = None;
                tokio::time::sleep(WALKER_TICK).await;
            }
            Err(_) => {} // still waiting for that piece: re-evaluate the playhead
        }
    }
}

/// `AsyncRead` wrapper for player responses: moves the playhead as bytes are served and records
/// how long the response has been blocked on a missing piece (stall detection).
pub struct TrackedReader<R> {
    inner: R,
    playback: Option<Arc<Playback>>,
    generation: u64,
    pos: u64,
    waiting: bool,
}

impl<R> TrackedReader<R> {
    pub fn new(inner: R, playback: Option<(Arc<Playback>, u64)>, start: u64) -> Self {
        let (playback, generation) = match playback {
            Some((p, g)) => (Some(p), g),
            None => (None, 0),
        };
        if let Some(p) = &playback {
            p.open_responses.fetch_add(1, Ordering::AcqRel);
        }
        Self { inner, playback, generation, pos: start, waiting: false }
    }

    fn set_waiting(&mut self, waiting: bool) {
        if self.waiting == waiting {
            return;
        }
        self.waiting = waiting;
        let Some(p) = &self.playback else { return };
        if waiting {
            if p.waiting.fetch_add(1, Ordering::AcqRel) == 0 {
                p.wait_since_ms.store(now_ms().max(1), Ordering::Release);
            }
        } else if p.waiting.fetch_sub(1, Ordering::AcqRel) == 1 {
            p.wait_since_ms.store(0, Ordering::Release);
        }
    }
}

impl<R> Drop for TrackedReader<R> {
    fn drop(&mut self) {
        self.set_waiting(false);
        if let Some(p) = &self.playback {
            p.open_responses.fetch_sub(1, Ordering::AcqRel);
            p.last_activity_ms.store(now_ms(), Ordering::Relaxed);
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for TrackedReader<R> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let res = std::pin::Pin::new(&mut self.inner).poll_read(cx, buf);
        match &res {
            Poll::Pending => self.set_waiting(true),
            Poll::Ready(_) => {
                self.set_waiting(false);
                let n = (buf.filled().len() - before) as u64;
                self.pos += n;
                if let Some(p) = &self.playback {
                    if self.generation != 0 && p.generation.load(Ordering::Acquire) == self.generation {
                        p.playhead.store(self.pos, Ordering::Release);
                    }
                }
            }
        }
        res
    }
}

/// 1 Hz health monitor + recovery. Holds only a `Weak<Engine>`.
pub fn spawn_monitor(engine: &Arc<Engine>) {
    let weak = Arc::downgrade(engine);
    engine.runtime.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let Some(engine) = weak.upgrade() else { return };
            monitor_once(&engine);
        }
    });
}

/// What the monitor decides for one torrent, from plain observations (unit-tested).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Observation {
    pub now_ms: u64,
    pub streaming: bool,
    pub live: bool,
    pub finished: bool,
    pub peers_live: u32,
    pub progress_bytes: u64,
    pub waiting_for: Option<Duration>,
}

fn evaluate(h: &mut HealthState, o: Observation) -> bool {
    if !o.streaming || !o.live || o.finished {
        h.no_peers_since_ms = 0;
        h.label = if o.streaming { "ok" } else { "idle" };
        return false;
    }
    if o.progress_bytes != h.last_progress_bytes || h.last_progress_ms == 0 {
        h.last_progress_bytes = o.progress_bytes;
        h.last_progress_ms = o.now_ms;
    }
    if o.peers_live == 0 {
        if h.no_peers_since_ms == 0 {
            h.no_peers_since_ms = o.now_ms;
        }
    } else {
        h.no_peers_since_ms = 0;
    }
    let no_peers_for = (h.no_peers_since_ms > 0).then(|| Duration::from_millis(o.now_ms - h.no_peers_since_ms));
    let no_progress_for = Duration::from_millis(o.now_ms - h.last_progress_ms);
    let stalled = o.waiting_for.is_some_and(|w| w >= STALL_AFTER);

    let recently_recovered = h.last_recovery_ms > 0 && o.now_ms - h.last_recovery_ms < 10_000;
    h.label = if recently_recovered && (stalled || o.peers_live == 0) {
        "recovering"
    } else if stalled {
        "stalled"
    } else if o.peers_live == 0 {
        "searching"
    } else {
        "ok"
    };

    let want = no_peers_for.is_some_and(|d| d >= RECOVER_NO_PEERS_AFTER)
        || (o.waiting_for.is_some_and(|w| w >= RECOVER_STALL_AFTER) && no_progress_for >= RECOVER_STALL_AFTER);
    if h.recover_interval.is_zero() {
        h.recover_interval = RECOVER_MIN_INTERVAL;
    }
    let allowed = h.last_recovery_ms == 0 || o.now_ms - h.last_recovery_ms >= h.recover_interval.as_millis() as u64;
    if want && allowed {
        if h.last_recovery_ms > 0 {
            h.recover_interval = (h.recover_interval * 2).min(RECOVER_MAX_INTERVAL);
        }
        h.last_recovery_ms = o.now_ms;
        h.recoveries += 1;
        h.no_peers_since_ms = 0;
        h.label = "recovering";
        return true;
    }
    if !want && o.peers_live > 0 && !stalled {
        // Healthy again: next trouble gets a quick recovery.
        h.recover_interval = RECOVER_MIN_INTERVAL;
    }
    false
}

fn monitor_once(engine: &Arc<Engine>) {
    let now = now_ms();
    let entries = engine.entries();
    let streaming = &engine.streaming;

    // Forget playbacks of removed torrents and idle ones (stops their walkers).
    {
        let mut map = streaming.playbacks.lock();
        map.retain(|hex, p| {
            let alive = entries.iter().any(|e| &e.hex == hex);
            let idle = p.open_responses.load(Ordering::Acquire) == 0
                && now.saturating_sub(p.last_activity_ms.load(Ordering::Relaxed)) > PLAYBACK_IDLE_TTL.as_millis() as u64;
            if !alive || idle {
                p.stop_walker();
            }
            alive && !idle
        });
    }
    streaming.health.lock().retain(|hex, _| entries.iter().any(|e| &e.hex == hex));

    for entry in entries {
        let Some(handle) = entry.handle() else { continue };
        let obs = observe(engine, &entry, &handle, now);
        let recover = {
            let mut map = streaming.health.lock();
            let h = map.entry(entry.hex.clone()).or_default();
            evaluate(h, obs)
        };
        if recover {
            info!(hex = %entry.hex, peers = obs.peers_live, waiting = ?obs.waiting_for, "stream stalled: re-announcing (pause + resume)");
            let session = engine.session.clone();
            engine.runtime.spawn(async move {
                if handle.is_paused() {
                    return;
                }
                if let Err(e) = session.pause(&handle).await {
                    warn!("recovery pause failed: {e:#}");
                    return;
                }
                if let Err(e) = session.unpause(&handle).await {
                    warn!("recovery resume failed: {e:#}");
                }
            });
        }
    }
}

fn observe(engine: &Engine, entry: &Entry, handle: &ManagedTorrentHandle, now: u64) -> Observation {
    let stats = handle.stats();
    let playback = engine.streaming.playback(&entry.hex);
    let live = stats.live.as_ref();
    Observation {
        now_ms: now,
        streaming: entry.active_streams.load(Ordering::Relaxed) > 0,
        live: live.is_some(),
        finished: stats.finished,
        peers_live: live.map(|l| l.snapshot.peer_stats.live).unwrap_or(0),
        progress_bytes: stats.progress_bytes,
        waiting_for: playback.and_then(|p| p.waiting_for()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obs(now_s: u64, peers: u32, progress: u64, waiting_s: Option<u64>) -> Observation {
        Observation {
            now_ms: now_s * 1000,
            streaming: true,
            live: true,
            finished: false,
            peers_live: peers,
            progress_bytes: progress,
            waiting_for: waiting_s.map(Duration::from_secs),
        }
    }

    #[test]
    fn piece_boundaries_follow_the_torrent_not_the_file() {
        // File starts 100 bytes into a torrent with 1000-byte pieces.
        let g = Geometry { file_offset: 100, file_len: 5000, piece_len: 1000 };
        assert_eq!(g.next_piece_start(0), 900);
        assert_eq!(g.next_piece_start(899), 900);
        assert_eq!(g.next_piece_start(900), 1900);
        assert_eq!(g.next_piece_start(4950), 5000, "clamped to the file end");
    }

    #[test]
    fn healthy_stream_is_ok_and_idle_when_not_streaming() {
        let mut h = HealthState::default();
        assert!(!evaluate(&mut h, obs(1, 10, 100, None)));
        assert_eq!(h.label, "ok");
        let mut o = obs(2, 10, 100, None);
        o.streaming = false;
        assert!(!evaluate(&mut h, o));
        assert_eq!(h.label, "idle");
    }

    #[test]
    fn no_peers_is_searching_then_recovers_once_then_backs_off() {
        let mut h = HealthState::default();
        assert!(!evaluate(&mut h, obs(100, 0, 0, None)));
        assert_eq!(h.label, "searching");
        assert!(!evaluate(&mut h, obs(111, 0, 0, None)));
        assert!(evaluate(&mut h, obs(112, 0, 0, None)), "12 s without peers → recovery");
        assert_eq!(h.label, "recovering");
        assert_eq!(h.recoveries, 1);
        // Still no peer: next recovery only after the 30 s interval.
        for t in 113..142 {
            assert!(!evaluate(&mut h, obs(t, 0, 0, None)), "t={t}");
        }
        assert!(evaluate(&mut h, obs(142, 0, 0, None)));
        // Then the interval doubles (60 s).
        for t in 143..202 {
            assert!(!evaluate(&mut h, obs(t, 0, 0, None)), "t={t}");
        }
        assert!(evaluate(&mut h, obs(202, 0, 0, None)));
        assert_eq!(h.recoveries, 3);
    }

    #[test]
    fn stall_with_peers_but_no_progress_recovers() {
        let mut h = HealthState::default();
        assert!(!evaluate(&mut h, obs(10, 5, 1000, Some(0))));
        assert!(!evaluate(&mut h, obs(16, 5, 1000, Some(6))));
        assert_eq!(h.label, "stalled");
        assert!(!evaluate(&mut h, obs(29, 5, 1000, Some(19))));
        assert!(evaluate(&mut h, obs(30, 5, 1000, Some(20))));
    }

    #[test]
    fn slow_but_progressing_stall_does_not_recover() {
        let mut h = HealthState::default();
        for t in 0..60 {
            // Bytes keep arriving (other pieces) while the player waits: the swarm works, the
            // read-ahead does its job; tearing the peers down would only make it worse.
            assert!(!evaluate(&mut h, obs(t, 5, t * 1000, Some(t))), "t={t}");
        }
        assert_eq!(h.label, "stalled");
    }

    #[test]
    fn finished_torrent_never_recovers() {
        let mut h = HealthState::default();
        let mut o = obs(100, 0, 0, Some(100));
        o.finished = true;
        assert!(!evaluate(&mut h, o));
        assert_eq!(h.label, "ok");
    }
}
