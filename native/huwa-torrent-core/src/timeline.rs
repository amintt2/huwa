//! Start timeline of a stream: where the time between "URL handed to the player" and "first
//! frame" goes, measured on the device (the simulation in `startup_sim.rs` turned out optimistic).
//!
//! One `StartTimeline` per torrent entry, reset by every `startStream` call (a replay of a cached
//! episode is a new start). Marks are milliseconds since that call; the epoch of the call is
//! reported too, so the app can put them on the same axis as its own start trace (tap → frame).
//! Numbers only: nothing here names the torrent or the file.
//!
//! - `metaMs` + `metaFrom`: metadata usable (`probe` = `.torrent` bytes cached by the swarm probe,
//!   `magnet` = fetched from peers now, `engine` = torrent already in the engine).
//! - `firstPeerMs`: first connected peer. `firstPieceMs`: the played file has its first verified
//!   piece (0 when it already had data).
//! - `firstRequestMs` / `firstByteMs`: first HTTP request of the player / first body byte served.
//! - `bytesServed`, `requests`, `tailRequests`: bytes sent to the player, HTTP requests, and those
//!   classified as container-index reads at the end of the file (MKV Cues/Tags, MP4 `moov`).

use std::{
    sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use parking_lot::Mutex;
use serde::Serialize;

/// Where the metadata of a start came from (`metaFrom`).
pub const META_UNKNOWN: u8 = 0;
pub const META_PROBE: u8 = 1;
pub const META_MAGNET: u8 = 2;
pub const META_ENGINE: u8 = 3;

const NONE: u64 = u64::MAX;

fn epoch_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub struct StartTimeline {
    origin: Mutex<(Instant, u64)>,
    meta: AtomicU64,
    meta_from: AtomicU8,
    first_peer: AtomicU64,
    first_piece: AtomicU64,
    first_request: AtomicU64,
    first_byte: AtomicU64,
    bytes_served: AtomicU64,
    requests: AtomicU32,
    tail_requests: AtomicU32,
    peers_at_first_byte: AtomicU32,
    initial_peers: AtomicU32,
    /// 0 = librqbit default.
    peer_limit: AtomicU32,
    piece_len: AtomicU64,
    /// Bumped by `begin`: a watcher of an older start stops.
    epoch: AtomicU32,
    watching: AtomicBool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartTimelineView {
    /// Epoch ms of the `startStream` call.
    pub started_at: u64,
    pub meta_ms: Option<u64>,
    pub meta_from: &'static str,
    pub first_peer_ms: Option<u64>,
    pub first_piece_ms: Option<u64>,
    pub first_request_ms: Option<u64>,
    pub first_byte_ms: Option<u64>,
    pub bytes_served: u64,
    pub requests: u32,
    pub tail_requests: u32,
    pub peers_at_first_byte: Option<u32>,
    pub initial_peers: u32,
    pub peer_limit: Option<u32>,
    pub piece_bytes: Option<u64>,
}

impl Default for StartTimeline {
    fn default() -> Self {
        Self {
            origin: Mutex::new((Instant::now(), epoch_ms())),
            meta: AtomicU64::new(NONE),
            meta_from: AtomicU8::new(META_UNKNOWN),
            first_peer: AtomicU64::new(NONE),
            first_piece: AtomicU64::new(NONE),
            first_request: AtomicU64::new(NONE),
            first_byte: AtomicU64::new(NONE),
            bytes_served: AtomicU64::new(0),
            requests: AtomicU32::new(0),
            tail_requests: AtomicU32::new(0),
            peers_at_first_byte: AtomicU32::new(u32::MAX),
            initial_peers: AtomicU32::new(0),
            peer_limit: AtomicU32::new(0),
            piece_len: AtomicU64::new(0),
            epoch: AtomicU32::new(0),
            watching: AtomicBool::new(false),
        }
    }
}

fn opt(v: u64) -> Option<u64> {
    (v != NONE).then_some(v)
}

impl StartTimeline {
    /// A new start (`startStream`): every mark is cleared. Returns the start's epoch number.
    pub fn begin(&self) -> u32 {
        *self.origin.lock() = (Instant::now(), epoch_ms());
        for a in [&self.meta, &self.first_peer, &self.first_piece, &self.first_request, &self.first_byte] {
            a.store(NONE, Ordering::Relaxed);
        }
        self.meta_from.store(META_UNKNOWN, Ordering::Relaxed);
        self.bytes_served.store(0, Ordering::Relaxed);
        self.requests.store(0, Ordering::Relaxed);
        self.tail_requests.store(0, Ordering::Relaxed);
        self.peers_at_first_byte.store(u32::MAX, Ordering::Relaxed);
        self.initial_peers.store(0, Ordering::Relaxed);
        self.epoch.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub fn epoch(&self) -> u32 {
        self.epoch.load(Ordering::Acquire)
    }

    /// Milliseconds since `begin`.
    pub fn elapsed_ms(&self) -> u64 {
        self.origin.lock().0.elapsed().as_millis() as u64
    }

    fn mark(&self, slot: &AtomicU64) -> bool {
        slot.compare_exchange(NONE, self.elapsed_ms(), Ordering::AcqRel, Ordering::Relaxed).is_ok()
    }

    pub fn mark_meta(&self, from: u8) {
        if self.mark(&self.meta) {
            self.meta_from.store(from, Ordering::Relaxed);
        }
    }
    pub fn mark_first_peer(&self) {
        self.mark(&self.first_peer);
    }
    pub fn mark_first_piece(&self) {
        self.mark(&self.first_piece);
    }
    pub fn has_first_peer(&self) -> bool {
        self.first_peer.load(Ordering::Relaxed) != NONE
    }
    pub fn has_first_piece(&self) -> bool {
        self.first_piece.load(Ordering::Relaxed) != NONE
    }
    pub fn has_first_byte(&self) -> bool {
        self.first_byte.load(Ordering::Relaxed) != NONE
    }

    /// An HTTP request of the player arrived.
    pub fn on_request(&self) {
        self.mark(&self.first_request);
        self.requests.fetch_add(1, Ordering::Relaxed);
    }

    /// That request reads the container index at the end of the file.
    pub fn on_tail_request(&self) {
        self.tail_requests.fetch_add(1, Ordering::Relaxed);
    }

    /// Body bytes sent. Returns true for the very first ones of this start.
    pub fn on_bytes(&self, n: u64) -> bool {
        if n == 0 {
            return false;
        }
        self.bytes_served.fetch_add(n, Ordering::Relaxed);
        self.first_byte.load(Ordering::Relaxed) == NONE && self.mark(&self.first_byte)
    }

    pub fn set_peers_at_first_byte(&self, peers: u32) {
        self.peers_at_first_byte.store(peers, Ordering::Relaxed);
    }

    pub fn set_swarm_setup(&self, initial_peers: usize, peer_limit: Option<usize>) {
        self.initial_peers.store(initial_peers.min(u32::MAX as usize) as u32, Ordering::Relaxed);
        self.peer_limit.store(peer_limit.unwrap_or(0).min(u32::MAX as usize) as u32, Ordering::Relaxed);
    }

    pub fn set_piece_len(&self, bytes: u64) {
        self.piece_len.store(bytes, Ordering::Relaxed);
    }

    /// One startup watcher at a time (see `Engine::spawn_start_watcher`).
    pub fn try_start_watching(&self) -> bool {
        !self.watching.swap(true, Ordering::AcqRel)
    }
    pub fn stop_watching(&self) {
        self.watching.store(false, Ordering::Release);
    }

    pub fn view(&self) -> StartTimelineView {
        let peers = self.peers_at_first_byte.load(Ordering::Relaxed);
        let limit = self.peer_limit.load(Ordering::Relaxed);
        let piece = self.piece_len.load(Ordering::Relaxed);
        StartTimelineView {
            started_at: self.origin.lock().1,
            meta_ms: opt(self.meta.load(Ordering::Relaxed)),
            meta_from: match self.meta_from.load(Ordering::Relaxed) {
                META_PROBE => "probe",
                META_MAGNET => "magnet",
                META_ENGINE => "engine",
                _ => "unknown",
            },
            first_peer_ms: opt(self.first_peer.load(Ordering::Relaxed)),
            first_piece_ms: opt(self.first_piece.load(Ordering::Relaxed)),
            first_request_ms: opt(self.first_request.load(Ordering::Relaxed)),
            first_byte_ms: opt(self.first_byte.load(Ordering::Relaxed)),
            bytes_served: self.bytes_served.load(Ordering::Relaxed),
            requests: self.requests.load(Ordering::Relaxed),
            tail_requests: self.tail_requests.load(Ordering::Relaxed),
            peers_at_first_byte: (peers != u32::MAX).then_some(peers),
            initial_peers: self.initial_peers.load(Ordering::Relaxed),
            peer_limit: (limit > 0).then_some(limit),
            piece_bytes: (piece > 0).then_some(piece),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_are_set_once_and_reset_by_a_new_start() {
        let t = StartTimeline::default();
        let e1 = t.begin();
        assert_eq!(t.view().meta_ms, None);
        t.mark_meta(META_PROBE);
        t.mark_meta(META_MAGNET); // ignored: first one wins
        assert_eq!(t.view().meta_from, "probe");
        t.on_request();
        t.on_request();
        t.on_tail_request();
        assert!(t.on_bytes(100), "first bytes of the start");
        assert!(!t.on_bytes(50));
        assert!(!t.on_bytes(0));
        let v = t.view();
        assert!(v.meta_ms.is_some() && v.first_request_ms.is_some() && v.first_byte_ms.is_some());
        assert_eq!((v.requests, v.tail_requests, v.bytes_served), (2, 1, 150));
        assert!(v.first_request_ms.unwrap() <= v.first_byte_ms.unwrap());

        let e2 = t.begin();
        assert!(e2 > e1);
        let v = t.view();
        assert_eq!((v.meta_ms, v.first_byte_ms, v.bytes_served, v.requests), (None, None, 0, 0));
        assert_eq!(v.meta_from, "unknown");
        assert!(t.on_bytes(1), "a replay has its own first byte");
    }

    #[test]
    fn swarm_setup_is_reported() {
        let t = StartTimeline::default();
        t.begin();
        t.set_swarm_setup(42, Some(24));
        t.set_piece_len(2 << 20);
        t.set_peers_at_first_byte(7);
        let v = t.view();
        assert_eq!((v.initial_peers, v.peer_limit, v.piece_bytes, v.peers_at_first_byte), (42, Some(24), Some(2 << 20), Some(7)));
        t.set_swarm_setup(0, None);
        assert_eq!(t.view().peer_limit, None);
    }

    #[test]
    fn one_watcher_at_a_time() {
        let t = StartTimeline::default();
        assert!(t.try_start_watching());
        assert!(!t.try_start_watching());
        t.stop_watching();
        assert!(t.try_start_watching());
    }
}
